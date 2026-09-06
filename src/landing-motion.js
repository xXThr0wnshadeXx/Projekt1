// Progressive enhancement: content stays readable without motion or JavaScript.
const preference = matchMedia('(prefers-reduced-motion: reduce)');
const groups = [
  ['.hero-copy > *', 'left', 65],
  ['.art-person', 'tile', 100],
  ['.how-section > div:first-child', 'left', 0],
  ['.steps article', 'up', 110],
  ['.signup-section > div:first-child', 'left', 0],
  ['.signup-card', 'glimmer', 0],
  ['.welcome-footer > *', 'up', 70],
];

if (!preference.matches && 'IntersectionObserver' in window) {
  const active = new Set();
  const finish = element => {
    element.classList.remove('scroll-revealed');
    active.delete(element);
  };
  const observer = new IntersectionObserver(entries => {
    for (const {target, isIntersecting} of entries) {
      if (!isIntersecting) { finish(target); continue; }
      // Hash navigation and keyboard focus must never animate active controls away.
      if (target.contains(document.activeElement)) continue;
      target.classList.add('scroll-revealed');
      active.add(target);
    }
  }, {threshold: 0, rootMargin: '0px 0px -24px 0px'});
  for (const [selector, motion, stagger] of groups) {
    document.querySelectorAll(selector).forEach((element, index) => {
      element.dataset.motion = motion;
      element.style.setProperty('--reveal-delay', `${index * stagger}ms`);
      element.addEventListener('animationend', event => {
        if (event.target === element) finish(element);
      });
      observer.observe(element);
    });
  }
  document.addEventListener('focusin', event => {
    for (const element of active) if (element.contains(event.target)) finish(element);
  });
  preference.addEventListener('change', event => {
    if (!event.matches) return;
    observer.disconnect();
    for (const element of active) finish(element);
  });
}
