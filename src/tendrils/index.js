import Shader from 'gl-shader';
import makeFBO from 'gl-fbo';
import triangle from 'a-big-triangle';
import ndarray from 'ndarray';

import Particles from './particles';
import { step } from '../utils';


// Shaders

import logicFrag from './shaders/logic.frag.glsl';

import flowVert from './shaders/flow.vert.glsl';
import flowFrag from './shaders/flow.frag.glsl';

import renderVert from './shaders/render.vert.glsl';
import renderFrag from './shaders/render.frag.glsl';

import triangleVert from './shaders/triangle.vert.glsl';

import copyFadeFrag from './shaders/copy-fade.frag.glsl';


export class Tendrils {
    constructor(gl, settings) {
        this.gl = gl;
        this.state = Object.assign({}, defaultSettings, settings);

        this.flow = makeFBO(this.gl, [1, 1], { float: true });

        // Multiple bufferring
        /**
         * @todo May need more buffers/passes later
         */
        this.buffers = [
            makeFBO(this.gl, [1, 1], { float: true }),
            makeFBO(this.gl, [1, 1], { float: true })
        ];


        this.renderShader = Shader(this.gl, renderVert, renderFrag);
        this.flowShader = Shader(this.gl, flowVert, flowFrag);
        this.fadeShader = Shader(this.gl, triangleVert, copyFadeFrag);


        this.shape = null;
        this.particles = null;

        this.start = Date.now();
        this.time = 0;

        this.spawnData = null;

        this.tempData = [];

        /**
         * Set particles at a moving offset to their spawn positions.
         * For now, this is just the center.
         */

        this.respawnOffset = [0, 0];
        this.spawnDataOffset = 0;


        this.setup();
        this.reset();
    }

    setup(...rest) {
        this.setupParticles(...rest);
        // this.setupSpawnData(...rest);
    }

    reset(...rest) {
        this.resetParticles(...rest);
        // this.resetSpawnData(...rest);
    }

    // @todo
    dispose() {
        this.particles.dispose();

        delete this.particles;
        delete this.spawnData;
    }


    setupParticles(rootNum = this.state.rootNum) {
        this.shape = [rootNum, rootNum];

        this.particles = new Particles(this.gl, {
                shape: this.shape,

                // Double the rootNum of (vertical neighbour) vertices, to have
                // pairs alternating between previous and current state.
                // (Vertical neighbours, because WebGL iterates column-major.)
                geomShape: [this.shape[0], this.shape[1]*2],

                logic: logicFrag,
                render: this.renderShader
            });

        this.particles.setup(this.state.numBuffers || 2);
    }

    // Populate the particles with the given spawn function
    resetParticles(spawn = this.spawn.bind(this)) {
        this.particles.spawn(spawn);
    }


    // Setting particles

    /**
     * Used in a big loop, so should be optimised.
     */
    
    spawn(data, u, v) {
        let radius = this.state.startRadius;
        let speed = this.state.startSpeed;

        let angle = Math.random()*Math.PI*2;
        let scaled = Math.random()*radius;

        // Position
        data[0] = Math.cos(angle)*scaled;
        data[1] = Math.sin(angle)*scaled;


        // Velocity

        angle = Math.random()*Math.PI*2;
        scaled = Math.random()*speed;

        data[2] = Math.cos(angle)*scaled;
        data[3] = Math.sin(angle)*scaled;

        return data;
    }

    inert(data, u, v) {
        data[0] = data[1] = -10000;
        data[2] = data[3] = 0;

        return data;
    }


    // Rendering and logic

    clearView() {
        this.buffers.forEach((buffer) => {
            buffer.bind();
            this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        });

        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }

    clearFlow() {
        this.flow.bind();
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }

    restart() {
        this.clearView();
        this.clearFlow();
        this.reset();
    }

    render() {
        const directRender = this.directRender();

        // Size
        
        const width = this.gl.drawingBufferWidth;
        const height = this.gl.drawingBufferHeight;
        const viewSize = [width, height];

        if(!directRender) {
            this.buffers.forEach((buffer) => buffer.shape = viewSize);
        }

        this.flow.shape = viewSize;


        // Time

        const t0 = this.time;
        this.time = Date.now()-this.start;


        // Physics

        if(!this.state.paused) {
            // Disabling blending here is important
            this.gl.disable(this.gl.BLEND);

            this.particles.step((uniforms) => Object.assign(uniforms, {
                    dt: (this.state.timeStep || this.time-t0),
                    time: this.time,
                    start: this.start,
                    flow: this.flow.color[0].bind(1),
                    viewSize
                },
                this.state));

            this.gl.enable(this.gl.BLEND);
            this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
        }


        // Flow FBO and view renders

        this.gl.viewport(0, 0, width, height);

        const drawUniforms = Object.assign({
                previous: this.particles.buffers[1].color[0].bind(1),
                resolution: this.shape,
                viewSize,
                time: this.time
            },
            this.state);

        this.flow.bind();

        // Render to the flow FBO - after the logic render, so particles don't
        // respond to their own flow.

        this.particles.render = this.flowShader;

        this.gl.lineWidth(this.state.flowWidth);
        this.particles.draw(drawUniforms, this.gl.LINES);


        // Render to the view.

        if(this.state.showFlow) {
            // Render the flow directly to the screen

            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);

            this.particles.draw((uniforms) =>
                    Object.assign(uniforms, drawUniforms),
                this.gl.LINES);
        }
        else {
            // Set up the particles for rendering
            this.particles.render = this.renderShader;
            this.gl.lineWidth(1);

            if(directRender) {
                // Render the particles directly to the screen

                this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);

                if(this.state.autoClearView) {
                    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
                }

                this.particles.draw(drawUniforms, this.gl.LINES);
            }
            else {
                // Multi-buffer passes

                this.buffers[0].bind();

                // Copy and fade the last buffer into the current buffer

                this.fadeShader.bind();

                Object.assign(this.fadeShader.uniforms, {
                        opacity: this.state.fadeOpacity,
                        view: this.buffers[1].color[0].bind(0),
                        viewSize
                    });

                triangle(this.gl);


                // Render the particles into the current buffer
                this.particles.draw(drawUniforms, this.gl.LINES);


                // Copy and fade the current buffer to the screen

                this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
                this.gl.clear(this.gl.COLOR_BUFFER_BIT);

                this.fadeShader.bind();

                Object.assign(this.fadeShader.uniforms, {
                        opacity: 1,
                        view: this.buffers[0].color[0].bind(0),
                        viewSize
                    });

                triangle(this.gl);

                // Step buffers
                step(this.buffers);
            }
        }
    }


    // @todo More specific, or derived from properties
    directRender(state = this.state) {
        return (state.autoClearView || state.fadeOpacity === 1);
    }


    // Respawn

    /**
     * @todo Is the old approach below approach needed? Could use a `spawn`
     *       sweep across sub-regions of the particles buffers.
     */
    
    respawn(spawn = this.spawn.bind(this)) {
        this.offsetRespawn(this.respawnOffset, this.respawnShape, this.shape);

        this.particles.spawn(spawn,
            this.particles.pixels
                .lo(...this.respawnOffset).hi(...this.respawnShape),
            this.respawnOffset);
    }

    
    // Cached respawn sweep

    setupSpawnData(rootNum = this.state.rootNum,
            respawnAmount = this.state.respawnAmount) {
        const side = Math.ceil(rootNum*respawnAmount);

        this.spawnData = ndarray(new Float32Array(side*side*4), [side, side, 4]);
    }

    respawnOld(spawn = this.spawn.bind(this)) {
        this.offsetRespawn(this.respawnOffset, this.spawnData.shape,
            this.shape);

        // Reset this part of the FBO
        this.particles.buffers.forEach((buffer) =>
            buffer.color[0].setPixels(this.spawnData, this.respawnOffset));


        // Finally, change some of the spawn data values for next time too,
        // a line at a time
        
        // Linear data stepping, no need for 2D
        this.spawnDataOffset += this.spawnData.shape[0]*4;

        // Wrap
        if(this.spawnDataOffset >= this.spawnData.data.length) {
            this.spawnDataOffset = 0;
        }

        // Check bounds
        this.spawnDataOffset = Math.min(this.spawnDataOffset,
            this.spawnData.data.length-(this.spawnData.shape[0]*4));

        for(let s = 0; s < this.spawnData.shape[1]; s += 4) {
            this.spawnData.data.set(spawn(tempData), this.spawnDataOffset+s);
        }
    }

    /**
     * Populate the respawn data with the given spawn function
     */
    resetSpawnData(spawn = this.spawn.bind(this)) {
        for(let i = 0; i < this.spawnData.shape[0]; ++i) {
            for(let j = 0; j < this.spawnData.shape[1]; ++j) {
                const spawned = spawn(this.tempData);

                this.spawnData.set(i, j, 0, spawned[0]);
                this.spawnData.set(i, j, 1, spawned[1]);
                this.spawnData.set(i, j, 2, spawned[2]);
                this.spawnData.set(i, j, 3, spawned[3]);
            }
        }
    }

    offsetRespawn(offset = this.respawnOffset, stride = this.respawnShape,
            shape = this.shape) {
        // Step the respawn shape horizontally and vertically within the FBO

        // X

        offset[0] += stride[0];

        // Wrap
        if(offset[0] >= shape[0]) {
            offset[0] = 0;
            // Step down Y - carriage return style
            offset[1] += stride[1];
        }

        // Clamp
        offset[0] = Math.min(offset[0],
            shape[0]-stride[0]);


        // Y

        // Wrap
        if(offset[1] >= shape[1]) {
            offset[1] = 0;
        }

        // Clamp
        offset[1] = Math.min(offset[1],
            shape[1]-stride[1]);

        return offset;
    }
};

export const defaultSettings = {
    rootNum: Math.pow(2, 9),

    paused: false,
    timeStep: 1000/60,

    autoClearView: true,
    showFlow: false,

    startRadius: 0.6,
    startSpeed: 0.01,

    maxSpeed: 0.01,
    damping: 0.045,

    flowDecay: 0.001,
    flowWidth: 3,

    noiseSpeed: 0.0005,

    forceWeight: 0.014,
    flowWeight: 1,
    wanderWeight: 0.0016,

    fadeOpacity: 1,
    color: [1, 1, 1, 0.4],

    respawnAmount: 0.007,
    respawnTick: 100
};

export const glSettings = {
    preserveDrawingBuffer: true
};


export default Tendrils;