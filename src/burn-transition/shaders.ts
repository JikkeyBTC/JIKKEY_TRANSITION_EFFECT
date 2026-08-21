export const VERTEX_SHADER_SOURCE = `#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

export const FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_snapshot;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_progress;
uniform vec2 u_origin;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }

float noise3(vec3 p) {
  vec3 cell = floor(p);
  vec3 local = p - cell;
  local = local * local * (3.0 - 2.0 * local);
  vec4 corners = cell.xxyy + vec4(0.0, 1.0, 0.0, 1.0);
  vec4 xHash = permute(corners.xyxy);
  vec4 xyHash = permute(xHash.xyxy + corners.zzww);
  vec4 zHash0 = permute(xyHash + cell.zzzz);
  vec4 zHash1 = permute(xyHash + cell.zzzz + 1.0);
  vec4 values0 = fract(zHash0 * (1.0 / 41.0));
  vec4 values1 = fract(zHash1 * (1.0 / 41.0));
  vec4 zMixed = mix(values0, values1, local.z);
  vec2 xMixed = mix(zMixed.xz, zMixed.yw, local.x);
  return mix(xMixed.x, xMixed.y, local.y);
}

float fbm(vec2 point, float timeValue) {
  float value = 0.0;
  float amplitude = 0.5;
  vec2 shift = vec2(100.0);
  for (int octave = 0; octave < 5; octave++) {
    value += amplitude * noise3(vec3(point, timeValue * 0.3));
    point = point * 2.0 + shift;
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  vec2 uv = v_uv;
  vec4 oldFrame = texture(u_snapshot, uv);
  if (u_progress <= 0.001) {
    fragColor = oldFrame;
    return;
  }
  if (u_progress >= 0.999) {
    fragColor = vec4(0.0);
    return;
  }

  vec2 aspect = vec2(u_resolution.x / max(u_resolution.y, 1.0), 1.0);
  vec2 delta = (uv - u_origin) * aspect;
  float distanceFromOrigin = length(delta);
  float angle = atan(delta.y, delta.x);
  float jagged = noise3(vec3(angle * 2.0, distanceFromOrigin * 5.0, 1.0)) * 0.3;
  distanceFromOrigin += jagged * 0.008;

  float radius = u_progress * 1.8;
  if (distanceFromOrigin > radius + 0.70) {
    fragColor = oldFrame;
    return;
  }
  if (distanceFromOrigin < radius - 0.18) {
    fragColor = vec4(0.0);
    return;
  }

  float noiseAmount = 0.35 * smoothstep(0.0, 0.3, radius);
  float edgeNoise = fbm(uv * 4.0, u_time) * noiseAmount;
  float burnDistance = distanceFromOrigin - (radius + edgeNoise);

  const float charWidth = 0.06;
  const float emberWidth = 0.025;
  const float heatWidth = 0.06;

  float burned = 1.0 - smoothstep(-charWidth, 0.0, burnDistance);
  float baseAlpha = 1.0 - burned;
  float ember = (1.0 - smoothstep(0.0, emberWidth, burnDistance))
    * smoothstep(-charWidth * 0.5, 0.0, burnDistance);
  float heat = (1.0 - smoothstep(0.0, heatWidth, burnDistance))
    * smoothstep(-0.01, 0.0, burnDistance);
  float charMask = burned
    * smoothstep(-charWidth * 1.5, -charWidth * 0.3, burnDistance);

  vec3 color = oldFrame.rgb;
  if (heat > 0.01) {
    vec2 heatOffset = vec2(
      noise3(vec3(uv * 20.0, u_time * 3.0)) - 0.5,
      noise3(vec3(uv * 20.0 + 100.0, u_time * 3.0)) - 0.5
    ) * 0.008 * heat;
    color = texture(u_snapshot, uv + heatOffset).rgb;
  }

  color = mix(color, vec3(0.05, 0.02, 0.0), charMask * 0.8);

  vec3 emberOuter = vec3(0.8, 0.2, 0.0);
  vec3 emberMiddle = vec3(1.0, 0.6, 0.1);
  vec3 emberCore = vec3(1.0, 0.95, 0.8);
  float emberNoise = noise3(vec3(uv * 30.0, u_time * 5.0));
  float emberIntensity = ember * (0.7 + 0.3 * emberNoise);
  vec3 emberColor = mix(emberOuter, emberMiddle, smoothstep(0.0, 0.5, emberIntensity));
  emberColor = mix(emberColor, emberCore, smoothstep(0.5, 1.0, emberIntensity));
  color += emberColor * emberIntensity * 2.0;

  float glow = (1.0 - smoothstep(0.0, 0.15, abs(burnDistance))) * 0.15;
  color += vec3(1.0, 0.4, 0.05) * glow;

  float smokeZone = (1.0 - smoothstep(0.0, 0.25, burnDistance)) * baseAlpha;
  if (smokeZone > 0.01) {
    vec2 smokeUv = uv;
    smokeUv.y += burnDistance * 0.8;
    float smoke = smoothstep(0.35, 0.65, fbm(smokeUv * 6.0, u_time * 0.8));
    float smokeDensity = smoke * smokeZone * 0.2;
    color = mix(color, vec3(0.15, 0.12, 0.1), smokeDensity);
  }

  float lightReach = (1.0 - smoothstep(0.0, 0.3, burnDistance)) * baseAlpha;
  float lightFlicker = 0.8 + 0.2 * noise3(vec3(uv * 5.0, u_time * 6.0));
  color += vec3(0.12, 0.04, 0.0) * lightReach * lightFlicker;

  float sparkAlpha = 0.0;
  vec3 sparkColor = vec3(0.0);
  if (burnDistance < 0.2 && burnDistance > -0.15) {
    vec2 sparkUv = uv * vec2(40.0, 25.0);
    vec2 sparkCell = floor(sparkUv);
    vec2 sparkLocal = fract(sparkUv) - 0.5;
    float seed = noise3(vec3(sparkCell, 0.0));
    if (seed > 0.82) {
      float sparkSpeed = 0.3 + seed * 0.5;
      float sparkLife = fract(seed * 17.3 + u_time * sparkSpeed);
      vec2 sparkPosition = vec2(
        sin(sparkLife * 6.2831853 + seed * 20.0) * 0.3,
        -sparkLife * 0.8 + 0.4
      );
      float sparkDistance = length(sparkLocal - sparkPosition);
      float brightness = 1.0 - smoothstep(0.01, 0.06, sparkDistance);
      float fade = sin(sparkLife * 3.1415926) * smoothstep(0.0, 0.1, sparkLife);
      float proximity = 1.0 - smoothstep(0.0, 0.2, abs(burnDistance + 0.02));
      sparkAlpha = brightness * fade * proximity * 0.8;
      sparkColor = mix(vec3(1.0, 0.5, 0.0), vec3(1.0, 0.9, 0.6), seed);
    }
  }

  vec3 premultiplied = color * baseAlpha + sparkColor * sparkAlpha;
  fragColor = vec4(premultiplied, baseAlpha);
}`;
