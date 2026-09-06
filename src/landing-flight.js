const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };

// Inspired by the sweeping mascot and layered scenery at treehacks.com (2026).
// Original path and artwork for Orbit. Scroll position is the only animation clock.
function bezier(points, t) {
  const u = 1 - t, [a,b,c,d] = points;
  return {
    x: u*u*u*a[0] + 3*u*u*t*b[0] + 3*u*t*t*c[0] + t*t*t*d[0],
    y: u*u*u*a[1] + 3*u*u*t*b[1] + 3*u*t*t*c[1] + t*t*t*d[1],
    dx: 3*u*u*(b[0]-a[0]) + 6*u*t*(c[0]-b[0]) + 3*t*t*(d[0]-c[0]),
    dy: 3*u*u*(b[1]-a[1]) + 6*u*t*(c[1]-b[1]) + 3*t*t*(d[1]-c[1]),
  };
}
export function flightPose(progress, aspect = 2) {
  const p = clamp(progress), space = smooth((p - .32) / .28);
  let point;
  if (p < .4) point = bezier([[26,82],[26,32],[85,75],[76,30]], smooth((p-.12)/.28));
  else if (p < .7) point = bezier([[76,30],[67,-15],[18,88],[18,50]], smooth((p-.4)/.3));
  else {
    const angle = Math.PI + smooth((p-.7)/.3)*Math.PI*2;
    point = {x:50+32*Math.cos(angle), y:50+30*Math.sin(angle), dx:-32*Math.sin(angle), dy:30*Math.cos(angle)};
  }
  const rawAngle = Math.atan2(point.dx*aspect,-point.dy)*180/Math.PI;
  // Keep the angle continuous around the back of the orbital ellipse.
  const orbitProgress = smooth((p-.7)/.3);
  const rotation = p < .7 ? rawAngle : rawAngle + (orbitProgress > .5 ? 360 : 0);
  return {
    x:point.x, y:point.y, rotation,
    scale:1.15 + .28*smooth((p-.12)/.16) - .66*smooth((p-.35)/.35),
    flame:smooth((p-.08)/.06)*(1-.65*smooth((p-.5)/.2)),
    ground:1-smooth((p-.18)/.2), space,
    farShift:-p*35, nearShift:-p*135,
    heading:1-smooth((p-.18)/.2),
    orbit:smooth((p-.61)/.09),
    stage:p<.14?0:p<.4?1:p<.7?2:3,
  };
}

if (typeof document !== 'undefined') {
  const journey = document.querySelector('.launch-journey');
  if (journey) {
    const stage = journey.querySelector('.launch-stage');
    const rocket = journey.querySelector('.flight-rocket');
    const scene = journey.querySelector('.launch-scene');
    const captions = [...journey.querySelectorAll('[data-flight-caption]')];
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = null;
    function render() {
      frame = null;
      const bounds = journey.getBoundingClientRect();
      const distance = journey.offsetHeight - stage.offsetHeight;
      const pose = flightPose(preference.matches ? 0 : distance > 0 ? -bounds.top / distance : 0, scene.clientWidth / Math.max(1, scene.clientHeight));
      rocket.style.left = `${pose.x}%`;
      rocket.style.top = `${pose.y}%`;
      rocket.style.transform = `translate(-50%, -50%) rotate(${pose.rotation}deg) scale(${pose.scale})`;
      journey.style.setProperty('--flight-fire', pose.flame);
      journey.style.setProperty('--flight-ground', pose.ground);
      journey.style.setProperty('--flight-space', pose.space);
      journey.style.setProperty('--flight-far-shift', `${pose.farShift}px`);
      journey.style.setProperty('--flight-near-shift', `${pose.nearShift}px`);
      journey.style.setProperty('--flight-heading', pose.heading);
      journey.style.setProperty('--flight-orbit', pose.orbit);
      journey.dataset.flightStage = pose.stage;
      captions.forEach((caption, index) => { caption.hidden = index !== pose.stage; });
    }
    function schedule() { if (frame === null) frame = requestAnimationFrame(render); }
    window.addEventListener('scroll', schedule, {passive: true});
    window.addEventListener('resize', schedule, {passive: true});
    window.addEventListener('pageshow', schedule);
    preference.addEventListener('change', schedule);
    journey.classList.add('flight-enabled');
    render();
  }
}
