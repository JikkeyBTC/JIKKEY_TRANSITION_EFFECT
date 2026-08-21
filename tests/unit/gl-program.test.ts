import { describe, expect, it, vi } from 'vitest';
import {
  WebGLBurnRenderer,
  compileShader,
  linkProgram,
} from '../../src/burn-transition/gl-program';

function createRendererHarness() {
  const vertexShader = { kind: 'vertex' } as unknown as WebGLShader;
  const fragmentShader = { kind: 'fragment' } as unknown as WebGLShader;
  const program = { kind: 'program' } as unknown as WebGLProgram;
  const vao = { kind: 'vao' } as unknown as WebGLVertexArrayObject;
  const buffer = { kind: 'buffer' } as unknown as WebGLBuffer;
  const texture = { kind: 'texture' } as unknown as WebGLTexture;
  const uniformLocations = new Map([
    ['u_snapshot', { name: 'u_snapshot' } as unknown as WebGLUniformLocation],
    ['u_resolution', { name: 'u_resolution' } as unknown as WebGLUniformLocation],
    ['u_time', { name: 'u_time' } as unknown as WebGLUniformLocation],
    ['u_progress', { name: 'u_progress' } as unknown as WebGLUniformLocation],
    ['u_origin', { name: 'u_origin' } as unknown as WebGLUniformLocation],
  ]);
  const gl = {
    COMPILE_STATUS: 1,
    LINK_STATUS: 2,
    VERTEX_SHADER: 3,
    FRAGMENT_SHADER: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    BLEND: 8,
    TEXTURE_2D: 9,
    TEXTURE_WRAP_S: 10,
    TEXTURE_WRAP_T: 11,
    TEXTURE_MIN_FILTER: 12,
    TEXTURE_MAG_FILTER: 13,
    CLAMP_TO_EDGE: 14,
    LINEAR: 15,
    UNPACK_FLIP_Y_WEBGL: 16,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 17,
    RGBA8: 18,
    RGBA: 19,
    UNSIGNED_BYTE: 20,
    MAX_TEXTURE_SIZE: 21,
    NO_ERROR: 0,
    COLOR_BUFFER_BIT: 22,
    TEXTURE0: 23,
    TRIANGLE_STRIP: 24,
    createShader: vi.fn()
      .mockReturnValueOnce(vertexShader)
      .mockReturnValueOnce(fragmentShader),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ''),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => program),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => ''),
    deleteProgram: vi.fn(),
    createVertexArray: vi.fn(() => vao),
    deleteVertexArray: vi.fn(),
    createBuffer: vi.fn(() => buffer),
    deleteBuffer: vi.fn(),
    bindVertexArray: vi.fn(),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    getAttribLocation: vi.fn(() => 0),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    getUniformLocation: vi.fn((_program: WebGLProgram, name: string) =>
      uniformLocations.get(name) ?? null),
    disable: vi.fn(),
    clearColor: vi.fn(),
    getParameter: vi.fn(() => 16_384),
    getError: vi.fn(() => 0),
    createTexture: vi.fn(() => texture),
    deleteTexture: vi.fn(),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    pixelStorei: vi.fn(),
    texImage2D: vi.fn(),
    viewport: vi.fn(),
    clear: vi.fn(),
    useProgram: vi.fn(),
    activeTexture: vi.fn(),
    uniform1i: vi.fn(),
    uniform2f: vi.fn(),
    uniform1f: vi.fn(),
    drawArrays: vi.fn(),
  } as unknown as WebGL2RenderingContext;
  const canvas = {
    getContext: vi.fn(() => gl),
    width: 1,
    height: 1,
    hidden: true,
    style: { pointerEvents: 'none' },
  } as unknown as HTMLCanvasElement;

  return {
    buffer,
    canvas,
    fragmentShader,
    gl,
    program,
    texture,
    uniformLocations,
    vao,
    vertexShader,
  };
}

describe('WebGL program helpers', () => {
  it('includes the driver log in a shader compile failure', () => {
    const gl = {
      COMPILE_STATUS: 1,
      createShader: vi.fn(() => ({})),
      shaderSource: vi.fn(),
      compileShader: vi.fn(),
      getShaderParameter: vi.fn(() => false),
      getShaderInfoLog: vi.fn(() => 'bad fragment shader'),
      deleteShader: vi.fn(),
    } as unknown as WebGL2RenderingContext;

    expect(() => compileShader(gl, 0x8b30, 'broken')).toThrow('bad fragment shader');
    expect(gl.deleteShader).toHaveBeenCalledOnce();
  });

  it('includes the driver log in a program link failure', () => {
    const gl = {
      LINK_STATUS: 1,
      createProgram: vi.fn(() => ({})),
      attachShader: vi.fn(),
      linkProgram: vi.fn(),
      getProgramParameter: vi.fn(() => false),
      getProgramInfoLog: vi.fn(() => 'bad program link'),
      deleteProgram: vi.fn(),
    } as unknown as WebGL2RenderingContext;

    expect(() => linkProgram(gl, {} as WebGLShader, {} as WebGLShader))
      .toThrow('bad program link');
    expect(gl.deleteProgram).toHaveBeenCalledOnce();
  });

  it('releases the vertex shader when fragment compilation fails during prepare', () => {
    const { canvas, fragmentShader, gl, vertexShader } = createRendererHarness();
    vi.mocked(gl.getShaderParameter)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    vi.mocked(gl.getShaderInfoLog).mockReturnValue('fragment rejected');
    const renderer = new WebGLBurnRenderer(canvas);

    expect(() => renderer.prepare()).toThrow('fragment rejected');

    expect(gl.deleteShader).toHaveBeenCalledWith(fragmentShader);
    expect(gl.deleteShader).toHaveBeenCalledWith(vertexShader);
  });

  it('releases every program resource when uniform discovery fails during prepare', () => {
    const {
      buffer,
      canvas,
      fragmentShader,
      gl,
      program,
      uniformLocations,
      vao,
      vertexShader,
    } = createRendererHarness();
    uniformLocations.delete('u_progress');
    const renderer = new WebGLBurnRenderer(canvas);

    expect(() => renderer.prepare()).toThrow('u_progress');

    expect(gl.deleteBuffer).toHaveBeenCalledWith(buffer);
    expect(gl.deleteVertexArray).toHaveBeenCalledWith(vao);
    expect(gl.deleteProgram).toHaveBeenCalledWith(program);
    expect(gl.deleteShader).toHaveBeenCalledWith(vertexShader);
    expect(gl.deleteShader).toHaveBeenCalledWith(fragmentShader);
  });

  it('deletes screenshot textures on replacement, release, and upload failure', () => {
    const firstTexture = {} as WebGLTexture;
    const secondTexture = {} as WebGLTexture;
    const failedTexture = {} as WebGLTexture;
    const getError = vi.fn(() => 0);
    const gl = {
      TEXTURE_2D: 1,
      TEXTURE_WRAP_S: 2,
      TEXTURE_WRAP_T: 3,
      TEXTURE_MIN_FILTER: 4,
      TEXTURE_MAG_FILTER: 5,
      CLAMP_TO_EDGE: 6,
      LINEAR: 7,
      UNPACK_FLIP_Y_WEBGL: 8,
      UNPACK_PREMULTIPLY_ALPHA_WEBGL: 9,
      RGBA8: 10,
      RGBA: 11,
      UNSIGNED_BYTE: 12,
      OUT_OF_MEMORY: 0x0505,
      MAX_TEXTURE_SIZE: 14,
      NO_ERROR: 0,
      getParameter: vi.fn(() => 16_384),
      getError,
      createTexture: vi.fn()
        .mockReturnValueOnce(firstTexture)
        .mockReturnValueOnce(secondTexture)
        .mockReturnValueOnce(failedTexture),
      deleteTexture: vi.fn(),
      bindTexture: vi.fn(),
      texParameteri: vi.fn(),
      pixelStorei: vi.fn(),
      texImage2D: vi.fn(),
    } as unknown as WebGL2RenderingContext;
    const canvas = {
      getContext: vi.fn(() => gl),
      hidden: true,
      style: { pointerEvents: 'none' },
    } as unknown as HTMLCanvasElement;
    const renderer = new WebGLBurnRenderer(canvas);
    const bitmap = {} as ImageBitmap;

    renderer.setFrame(bitmap);
    renderer.setFrame(bitmap);
    renderer.releaseFrame();

    expect(gl.deleteTexture).toHaveBeenNthCalledWith(1, firstTexture);
    expect(gl.deleteTexture).toHaveBeenNthCalledWith(2, secondTexture);

    getError.mockReturnValueOnce(0).mockReturnValueOnce(gl.OUT_OF_MEMORY);
    expect(() => renderer.setFrame(bitmap)).toThrow('0x505');
    expect(gl.deleteTexture).toHaveBeenNthCalledWith(3, failedTexture);
  });

  it('drains every stale WebGL error before judging a texture upload', () => {
    const { canvas, gl } = createRendererHarness();
    vi.mocked(gl.getError)
      .mockReturnValueOnce(0x0500)
      .mockReturnValueOnce(0x0502)
      .mockReturnValueOnce(gl.NO_ERROR)
      .mockReturnValueOnce(gl.NO_ERROR);
    const renderer = new WebGLBurnRenderer(canvas);

    expect(() => renderer.setFrame({} as ImageBitmap)).not.toThrow();

    expect(gl.getError).toHaveBeenCalledTimes(4);
    expect(gl.texImage2D).toHaveBeenCalledOnce();
    expect(gl.deleteTexture).not.toHaveBeenCalled();
  });

  it('prepares the fullscreen quad and uploads every draw input', () => {
    const { canvas, gl, program, texture, uniformLocations, vao } = createRendererHarness();
    canvas.width = 640;
    canvas.height = 360;
    const renderer = new WebGLBurnRenderer(canvas);

    renderer.prepare();
    renderer.setFrame({} as ImageBitmap);
    renderer.setOrigin({ x: 0.25, y: 0.75 });
    renderer.draw(0.4, 12.5);

    expect(gl.getAttribLocation).toHaveBeenCalledWith(program, 'a_position');
    expect(gl.enableVertexAttribArray).toHaveBeenCalledWith(0);
    expect(gl.vertexAttribPointer).toHaveBeenCalledWith(0, 2, gl.FLOAT, false, 0, 0);
    const quad = vi.mocked(gl.bufferData).mock.calls[0]?.[1];
    expect(quad).toBeInstanceOf(Float32Array);
    expect(Array.from(quad as Float32Array)).toEqual([-1, -1, 1, -1, -1, 1, 1, 1]);
    expect(gl.viewport).toHaveBeenCalledWith(0, 0, 640, 360);
    expect(gl.useProgram).toHaveBeenCalledWith(program);
    expect(gl.bindVertexArray).toHaveBeenLastCalledWith(vao);
    expect(gl.bindTexture).toHaveBeenLastCalledWith(gl.TEXTURE_2D, texture);
    expect(gl.uniform1i).toHaveBeenCalledWith(uniformLocations.get('u_snapshot'), 0);
    expect(gl.uniform2f).toHaveBeenCalledWith(
      uniformLocations.get('u_resolution'),
      640,
      360,
    );
    expect(gl.uniform1f).toHaveBeenCalledWith(uniformLocations.get('u_time'), 12.5);
    expect(gl.uniform1f).toHaveBeenCalledWith(uniformLocations.get('u_progress'), 0.4);
    expect(gl.uniform2f).toHaveBeenCalledWith(
      uniformLocations.get('u_origin'),
      0.25,
      0.75,
    );
    expect(gl.drawArrays).toHaveBeenCalledWith(gl.TRIANGLE_STRIP, 0, 4);
  });

  it('caches the validated maximum texture dimension at construction', () => {
    const { canvas, gl } = createRendererHarness();
    const renderer = new WebGLBurnRenderer(canvas);
    vi.mocked(gl.getParameter).mockReturnValue(1_024);

    expect(renderer.maximumTextureSize()).toBe(16_384);
    expect(renderer.maximumTextureSize()).toBe(16_384);
    expect(gl.getParameter).toHaveBeenCalledOnce();
    expect(gl.getParameter).toHaveBeenCalledWith(gl.MAX_TEXTURE_SIZE);
  });

  it('resizes the backing store without allocating GPU resources', () => {
    const { canvas, gl } = createRendererHarness();
    const renderer = new WebGLBurnRenderer(canvas);

    renderer.resize({ width: 200, height: 100 }, 2, 30_000);

    expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 244, height: 122 });
    expect(gl.createShader).not.toHaveBeenCalled();
    expect(gl.createProgram).not.toHaveBeenCalled();
    expect(gl.createVertexArray).not.toHaveBeenCalled();
    expect(gl.createBuffer).not.toHaveBeenCalled();
    expect(gl.createTexture).not.toHaveBeenCalled();
  });

  it('rejects drawing until both program resources and a frame are ready', () => {
    const { canvas, gl } = createRendererHarness();
    const renderer = new WebGLBurnRenderer(canvas);

    expect(() => renderer.draw(0.2, 1)).toThrow('not ready');
    renderer.prepare();
    expect(() => renderer.draw(0.2, 1)).toThrow('not ready');
    expect(gl.drawArrays).not.toHaveBeenCalled();
  });

  it('cleans the surviving quad allocation when its paired allocation fails', () => {
    const { canvas, fragmentShader, gl, program, vao, vertexShader } =
      createRendererHarness();
    vi.mocked(gl.createBuffer).mockReturnValue(null as unknown as WebGLBuffer);
    const renderer = new WebGLBurnRenderer(canvas);

    expect(() => renderer.prepare()).toThrow('Unable to allocate burn quad');

    expect(gl.deleteVertexArray).toHaveBeenCalledWith(vao);
    expect(gl.deleteProgram).toHaveBeenCalledWith(program);
    expect(gl.deleteShader).toHaveBeenCalledWith(vertexShader);
    expect(gl.deleteShader).toHaveBeenCalledWith(fragmentShader);
  });

  it('releases each generation exactly once across re-prepare and repeated destroy', () => {
    const first = createRendererHarness();
    const secondVertex = { generation: 2, kind: 'vertex' } as unknown as WebGLShader;
    const secondFragment = { generation: 2, kind: 'fragment' } as unknown as WebGLShader;
    const secondProgram = { generation: 2, kind: 'program' } as unknown as WebGLProgram;
    const secondVao = { generation: 2, kind: 'vao' } as unknown as WebGLVertexArrayObject;
    const secondBuffer = { generation: 2, kind: 'buffer' } as unknown as WebGLBuffer;
    vi.mocked(first.gl.createShader)
      .mockReset()
      .mockReturnValueOnce(first.vertexShader)
      .mockReturnValueOnce(first.fragmentShader)
      .mockReturnValueOnce(secondVertex)
      .mockReturnValueOnce(secondFragment);
    vi.mocked(first.gl.createProgram)
      .mockReset()
      .mockReturnValueOnce(first.program)
      .mockReturnValueOnce(secondProgram);
    vi.mocked(first.gl.createVertexArray)
      .mockReset()
      .mockReturnValueOnce(first.vao)
      .mockReturnValueOnce(secondVao);
    vi.mocked(first.gl.createBuffer)
      .mockReset()
      .mockReturnValueOnce(first.buffer)
      .mockReturnValueOnce(secondBuffer);
    const renderer = new WebGLBurnRenderer(first.canvas);

    renderer.prepare();
    renderer.setFrame({} as ImageBitmap);
    renderer.prepare();
    renderer.destroy();
    renderer.destroy();

    expect(vi.mocked(first.gl.deleteBuffer).mock.calls.map(([resource]) => resource))
      .toEqual([first.buffer, secondBuffer]);
    expect(vi.mocked(first.gl.deleteVertexArray).mock.calls.map(([resource]) => resource))
      .toEqual([first.vao, secondVao]);
    expect(vi.mocked(first.gl.deleteProgram).mock.calls.map(([resource]) => resource))
      .toEqual([first.program, secondProgram]);
    expect(vi.mocked(first.gl.deleteShader).mock.calls.map(([resource]) => resource))
      .toEqual([
        first.vertexShader,
        first.fragmentShader,
        secondVertex,
        secondFragment,
      ]);
    expect(first.gl.deleteTexture).toHaveBeenCalledOnce();
    expect(first.gl.deleteTexture).toHaveBeenCalledWith(first.texture);
    expect(first.canvas.hidden).toBe(true);
    expect(first.canvas.style.pointerEvents).toBe('none');
  });
});
