// Bouton de bascule clair / sombre des pages de contenu (« Comment ça marche »,
// mentions légales). L'outil et la page Alertes ont le leur dans app.js et
// alertes.js. Même convention que theme-init.js.
(function () {
  var btn = document.getElementById('themeToggle');
  var icon = document.getElementById('themeIcon');
  if (!btn || !icon) return;

  function apply(t) {
    if (t === 'dark') { document.documentElement.setAttribute('data-theme', 'dark'); icon.textContent = '☀'; }
    else { document.documentElement.removeAttribute('data-theme'); icon.textContent = '☾'; }
  }

  var saved = null;
  try { saved = localStorage.getItem('octane-theme'); } catch (e) {}
  apply(saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

  btn.addEventListener('click', function () {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('octane-theme', next); } catch (e) {}
    apply(next);
  });
})();
