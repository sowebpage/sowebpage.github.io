(function () {
  function initFeatureTooltips() {
    var markers = document.querySelectorAll('.feature-marker');
    if (!markers.length) return;

    var tip = document.createElement('div');
    tip.className = 'feature-tooltip';
    tip.setAttribute('hidden', '');
    document.body.appendChild(tip);

    markers.forEach(function (marker) {
      marker.addEventListener('mouseenter', function () {
        tip.textContent = marker.getAttribute('data-tooltip') || 'Featured';
        tip.removeAttribute('hidden');
      });

      marker.addEventListener('mousemove', function (event) {
        tip.style.left = event.clientX + 'px';
        tip.style.top = event.clientY + 'px';
      });

      marker.addEventListener('mouseleave', function () {
        tip.setAttribute('hidden', '');
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFeatureTooltips);
  } else {
    initFeatureTooltips();
  }
})();
