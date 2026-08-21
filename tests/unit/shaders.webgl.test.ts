import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  FRAGMENT_SHADER_SOURCE,
  VERTEX_SHADER_SOURCE,
} from '../../src/burn-transition/shaders';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

describe('burn shaders in real WebGL2', () => {
  it('compiles and links the exported shader program without driver diagnostics', async () => {
    const result = await page.evaluate(({ vertexSource, fragmentSource }) => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return { webgl2: false } as const;
      const compile = (type: number, source: string) => {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('Unable to allocate shader in browser regression');
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        return {
          shader,
          ok: Boolean(gl.getShaderParameter(shader, gl.COMPILE_STATUS)),
          log: gl.getShaderInfoLog(shader) ?? '',
        };
      };
      const vertex = compile(gl.VERTEX_SHADER, vertexSource);
      const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
      const program = gl.createProgram();
      if (!program) throw new Error('Unable to allocate program in browser regression');
      gl.attachShader(program, vertex.shader);
      gl.attachShader(program, fragment.shader);
      gl.linkProgram(program);
      return {
        webgl2: true,
        vertexOk: vertex.ok,
        vertexLog: vertex.log,
        fragmentOk: fragment.ok,
        fragmentLog: fragment.log,
        linkOk: Boolean(gl.getProgramParameter(program, gl.LINK_STATUS)),
        linkLog: gl.getProgramInfoLog(program) ?? '',
      } as const;
    }, {
      vertexSource: VERTEX_SHADER_SOURCE,
      fragmentSource: FRAGMENT_SHADER_SOURCE,
    });

    expect(result).toEqual({
      webgl2: true,
      vertexOk: true,
      vertexLog: '',
      fragmentOk: true,
      fragmentLog: '',
      linkOk: true,
      linkLog: '',
    });
  });

  it('returns real driver diagnostics for a rejected fragment shader', async () => {
    const result = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return { webgl2: false, compiled: false, log: '' };
      const shader = gl.createShader(gl.FRAGMENT_SHADER);
      if (!shader) throw new Error('Unable to allocate shader in browser regression');
      gl.shaderSource(shader, `#version 300 es
        precision highp float;
        out vec4 color;
        void main() { color = definitely_not_valid; }
      `);
      gl.compileShader(shader);
      return {
        webgl2: true,
        compiled: Boolean(gl.getShaderParameter(shader, gl.COMPILE_STATUS)),
        log: gl.getShaderInfoLog(shader) ?? '',
      };
    });

    expect(result.webgl2).toBe(true);
    expect(result.compiled).toBe(false);
    expect(result.log.length).toBeGreaterThan(0);
  });

  it('keeps alpha at zero where sparse sparks add emissive RGB', async () => {
    const result = await page.evaluate(({ vertexSource, fragmentSource }) => {
      const size = 512;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const gl = canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
      });
      if (!gl) return { webgl2: false } as const;

      const compile = (type: number, source: string): WebGLShader => {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('Unable to allocate shader in pixel regression');
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader compile failed');
        }
        return shader;
      };
      const program = gl.createProgram();
      if (!program) throw new Error('Unable to allocate program in pixel regression');
      gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) ?? 'Program link failed');
      }

      const vao = gl.createVertexArray();
      const buffer = gl.createBuffer();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      );
      const position = gl.getAttribLocation(program, 'a_position');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

      const snapshot = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, snapshot);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 0]),
      );

      const output = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, output);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        size,
        size,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        output,
        0,
      );
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error('Pixel regression framebuffer is incomplete');
      }

      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, snapshot);
      gl.uniform1i(gl.getUniformLocation(program, 'u_snapshot'), 0);
      gl.uniform2f(gl.getUniformLocation(program, 'u_resolution'), size, size);
      gl.uniform1f(gl.getUniformLocation(program, 'u_time'), 0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_progress'), 0.15);
      gl.uniform2f(gl.getUniformLocation(program, 'u_origin'), 0.5, 0.5);
      gl.viewport(0, 0, size, size);
      gl.disable(gl.BLEND);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      const pixels = new Uint8Array(size * size * 4);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let sparkPixel: [number, number, number, number] | null = null;
      for (let index = 0; index < pixels.length; index += 4) {
        const red = pixels[index] ?? 0;
        const green = pixels[index + 1] ?? 0;
        const blue = pixels[index + 2] ?? 0;
        const alpha = pixels[index + 3] ?? 0;
        if (alpha === 0 && red + green + blue > 10) {
          sparkPixel = [red, green, blue, alpha];
          break;
        }
      }
      return { webgl2: true, sparkPixel } as const;
    }, {
      vertexSource: VERTEX_SHADER_SOURCE,
      fragmentSource: FRAGMENT_SHADER_SOURCE,
    });

    expect(result.webgl2).toBe(true);
    expect(result.sparkPixel).not.toBeNull();
    expect(result.sparkPixel?.[3]).toBe(0);
    expect((result.sparkPixel?.[0] ?? 0) + (result.sparkPixel?.[1] ?? 0)
      + (result.sparkPixel?.[2] ?? 0)).toBeGreaterThan(10);
  });
});
