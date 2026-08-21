import { calculateBackingSize } from './coordinates';
import { FRAGMENT_SHADER_SOURCE, VERTEX_SHADER_SOURCE } from './shaders';
import type { NormalizedOrigin, ViewportSize } from './types';

export function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Unable to allocate WebGL shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || 'Unknown shader compile error';
    gl.deleteShader(shader);
    throw new Error(`Burn shader compile failed: ${log}`);
  }
  return shader;
}

export function linkProgram(
  gl: WebGL2RenderingContext,
  vertex: WebGLShader,
  fragment: WebGLShader,
): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('Unable to allocate WebGL program');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || 'Unknown program link error';
    gl.deleteProgram(program);
    throw new Error(`Burn program link failed: ${log}`);
  }
  return program;
}

interface Uniforms {
  snapshot: WebGLUniformLocation;
  resolution: WebGLUniformLocation;
  time: WebGLUniformLocation;
  progress: WebGLUniformLocation;
  origin: WebGLUniformLocation;
}

function requiredUniform(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (location === null) throw new Error(`Burn shader uniform missing: ${name}`);
  return location;
}

export class WebGLBurnRenderer {
  private readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private vertexShader: WebGLShader | null = null;
  private fragmentShader: WebGLShader | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private buffer: WebGLBuffer | null = null;
  private frameTexture: WebGLTexture | null = null;
  private uniforms: Uniforms | null = null;
  private readonly maxTextureDimension: number;
  private originX = 0.5;
  private originY = 0.5;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) throw new Error('WebGL2 is unavailable');
    this.gl = gl;
    const maxTextureDimension = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    if (!Number.isFinite(maxTextureDimension) || maxTextureDimension < 1) {
      throw new Error('Unable to query WebGL maximum texture size');
    }
    this.maxTextureDimension = maxTextureDimension;
  }

  prepare(): void {
    this.destroyProgramObjects();
    const gl = this.gl;
    try {
      this.vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
      this.fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
      this.program = linkProgram(gl, this.vertexShader, this.fragmentShader);
      this.vao = gl.createVertexArray();
      this.buffer = gl.createBuffer();
      if (!this.vao || !this.buffer) throw new Error('Unable to allocate burn quad');

      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      );
      const position = gl.getAttribLocation(this.program, 'a_position');
      if (position < 0) throw new Error('Burn shader attribute missing: a_position');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      this.uniforms = {
        snapshot: requiredUniform(gl, this.program, 'u_snapshot'),
        resolution: requiredUniform(gl, this.program, 'u_resolution'),
        time: requiredUniform(gl, this.program, 'u_time'),
        progress: requiredUniform(gl, this.program, 'u_progress'),
        origin: requiredUniform(gl, this.program, 'u_origin'),
      };
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
    } catch (error) {
      this.destroyProgramObjects();
      throw error;
    }
  }

  maximumTextureSize(): number {
    return this.maxTextureDimension;
  }

  resize(viewport: ViewportSize, dpr: number, maxPixels: number): void {
    const backing = calculateBackingSize(viewport, dpr, maxPixels);
    if (this.canvas.width !== backing.width) this.canvas.width = backing.width;
    if (this.canvas.height !== backing.height) this.canvas.height = backing.height;
  }

  setFrame(bitmap: ImageBitmap): void {
    this.releaseFrame();
    const gl = this.gl;
    while (gl.getError() !== gl.NO_ERROR) {
      // Drain stale driver errors so only texImage2D failures are attributed here.
    }
    const texture = gl.createTexture();
    if (!texture) throw new Error('Unable to allocate burn frame texture');
    this.frameTexture = texture;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    const uploadError = gl.getError();
    if (uploadError !== gl.NO_ERROR) {
      this.releaseFrame();
      throw new Error(`Burn texture upload failed with WebGL error 0x${uploadError.toString(16)}`);
    }
  }

  setOrigin(origin: NormalizedOrigin): void {
    this.originX = origin.x;
    this.originY = origin.y;
  }

  draw(progress: number, absoluteTimeSeconds: number): void {
    const gl = this.gl;
    const program = this.program;
    const vao = this.vao;
    const uniforms = this.uniforms;
    if (!program || !vao || !uniforms || !this.frameTexture) {
      throw new Error('Burn renderer is not ready');
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
    gl.uniform1i(uniforms.snapshot, 0);
    gl.uniform2f(uniforms.resolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(uniforms.time, absoluteTimeSeconds);
    gl.uniform1f(uniforms.progress, progress);
    gl.uniform2f(uniforms.origin, this.originX, this.originY);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  show(): void {
    this.canvas.hidden = false;
    this.canvas.style.pointerEvents = 'auto';
  }

  hide(): void {
    this.canvas.hidden = true;
    this.canvas.style.pointerEvents = 'none';
  }

  releaseFrame(): void {
    if (this.frameTexture) this.gl.deleteTexture(this.frameTexture);
    this.frameTexture = null;
  }

  destroy(): void {
    this.hide();
    this.releaseFrame();
    this.destroyProgramObjects();
  }

  private destroyProgramObjects(): void {
    const gl = this.gl;
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    if (this.vertexShader) gl.deleteShader(this.vertexShader);
    if (this.fragmentShader) gl.deleteShader(this.fragmentShader);
    this.buffer = null;
    this.vao = null;
    this.program = null;
    this.vertexShader = null;
    this.fragmentShader = null;
    this.uniforms = null;
  }
}
