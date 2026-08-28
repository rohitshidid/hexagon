// Animated WebGL ocean/caustics background. Falls back to a CSS gradient if no WebGL.
export function startBackground(canvas) {
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  if (!gl) {
    canvas.style.background = 'radial-gradient(circle at 50% 30%, #14385f, #061122 70%)';
    return;
  }

  const vert = `
    attribute vec2 p;
    void main() { gl_Position = vec4(p, 0.0, 1.0); }
  `;

  // Layered value-noise waves + caustic shimmer, slowly drifting.
  const frag = `
    precision highp float;
    uniform vec2 res;
    uniform float t;

    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p){
      vec2 i = floor(p), f = fract(p);
      vec2 u = f*f*(3.0-2.0*f);
      return mix(mix(hash(i), hash(i+vec2(1,0)), u.x),
                 mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
    }
    float fbm(vec2 p){
      float v = 0.0, a = 0.5;
      for(int i=0;i<5;i++){ v += a*noise(p); p *= 2.02; a *= 0.5; }
      return v;
    }
    void main(){
      vec2 uv = gl_FragCoord.xy / res.xy;
      vec2 q = uv * 3.0;
      q.x *= res.x/res.y;
      float time = t * 0.05;

      // flowing domain warp
      vec2 w = vec2(fbm(q + time), fbm(q + vec2(5.2, 1.3) - time));
      float n = fbm(q + w*1.5 + time*0.5);

      // caustic ridges
      float caus = abs(sin((n + time) * 6.2831));
      caus = pow(caus, 3.0);

      vec3 deep = vec3(0.02, 0.07, 0.16);
      vec3 mid  = vec3(0.05, 0.20, 0.38);
      vec3 shal = vec3(0.10, 0.40, 0.62);
      vec3 col = mix(deep, mid, smoothstep(0.2, 0.7, n));
      col = mix(col, shal, smoothstep(0.55, 0.95, n));
      col += caus * vec3(0.10, 0.30, 0.45) * 0.6;

      // soft vignette + top glow
      float vig = smoothstep(1.25, 0.25, length(uv - 0.5));
      col *= 0.55 + 0.45 * vig;
      col += vec3(0.06, 0.12, 0.20) * smoothstep(0.8, 0.0, uv.y);

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('shader error', gl.getShaderInfoLog(s)); return null;
    }
    return s;
  }
  const prog = gl.createProgram();
  const vs = compile(gl.VERTEX_SHADER, vert), fs = compile(gl.FRAGMENT_SHADER, frag);
  if (!vs || !fs) { canvas.style.background = 'radial-gradient(circle at 50% 30%, #14385f, #061122 70%)'; return; }
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const uRes = gl.getUniformLocation(prog, 'res');
  const uT = gl.getUniformLocation(prog, 't');

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.floor(innerWidth * dpr);
    canvas.height = Math.floor(innerHeight * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();
  addEventListener('resize', resize);

  const start = performance.now();
  function loop() {
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uT, (performance.now() - start) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(loop);
  }
  loop();
}
