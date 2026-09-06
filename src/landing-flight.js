const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };

// One deterministic timeline: the same scroll position always yields the same pose.
export function flightPose(progress) {
  const p = clamp(progress), launch = smooth((p - .12) / .4), space = smooth((p - .43) / .22);
  const orbit = clamp((p - .65) / .35), angle = -Math.PI / 2 + orbit * Math.PI * 2;
  const orbiting = p >= .65;
  return {
    x: orbiting ? 50 + 32 * Math.cos(angle) : 50,
    y: orbiting ? 50 + 30 * Math.sin(angle) : 82 - 62 * launch,
    rotation: orbiting ? 90 + orbit * 360 : 90 * smooth((p - .52) / .13),
    flame: smooth((p - .1) / .06) * (1 - .7 * smooth((p - .55) / .12)),
    ground: 1 - smooth((p - .2) / .25),
    space,
    stage: p < .14 ? 0 : p < .43 ? 1 : p < .65 ? 2 : 3,
  };
}

if (typeof document !== 'undefined') {
  const journey = document.querySelector('.launch-journey');
  if (journey) {
    const stage = journey.querySelector('.launch-stage');
    const rocket = journey.querySelector('.flight-rocket');
    const captions = [...journey.querySelectorAll('[data-flight-caption]')];
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = null;
    function render() {
      frame = null;
      const bounds = journey.getBoundingClientRect();
      const distance = journey.offsetHeight - stage.offsetHeight;
      const pose = flightPose(preference.matches ? 0 : distance > 0 ? -bounds.top / distance : 0);
      rocket.style.left = `${pose.x}%`;
      rocket.style.top = `${pose.y}%`;
      rocket.style.transform = `translate(-50%, -50%) rotate(${pose.rotation}deg)`;
      journey.style.setProperty('--flight-fire', pose.flame);
      journey.style.setProperty('--flight-ground', pose.ground);
      journey.style.setProperty('--flight-space', pose.space);
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
