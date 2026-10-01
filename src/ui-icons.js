const EaselUiIcons = (() => {
  const paths = {
    copy: 'M7 7h10v10H7V7ZM13 7V3H3v10h4',
    check: 'm4 10 4 4 8-8',
    warning: 'M10 6v5M10 14h.01M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
    newChat: 'M10 3H3v14h14v-7M9 11l1-4 5-5 3 3-5 5-4 1ZM14 3l3 3',
    open: 'M10 3H3v14h14v-7M12 3h5v5M17 3l-8 8',
    download: 'M10 2v10m-4-4 4 4 4-4M3 13v4h14v-4',
    useInChat: 'M7 3h10v11h-4l-4 3v-3H7v-3M2 7h8M7 4l3 3-3 3',
  };

  function setActionIcon(document, button, icon, label) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(name, value);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', paths[icon]);
    svg.append(path);
    button.replaceChildren(svg);
    button.setAttribute('aria-label', label);
    button.title = label;
    return button;
  }

  return { setActionIcon };
})();

if (typeof module !== 'undefined') module.exports = EaselUiIcons;
