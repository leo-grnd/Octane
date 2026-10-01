// En-tête commun à toutes les pages : bascule clair / sombre. Chargé en defer
// par chaque page. Le thème enregistré est déjà appliqué avant le premier
// rendu par theme-init.js (même convention : le clair est le défaut, seul le
// sombre pose data-theme="dark" sur <html>, choix mémorisé sous la clé
// « octane-theme »). Les icônes soleil / lune basculent en CSS, d'après
// data-theme : rien à redessiner ici.
(function () {
  var root = document.documentElement;
  var themeBtn = document.getElementById('themeToggle');
  if (!themeBtn) return;

  themeBtn.addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    if (next === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    try { localStorage.setItem('octane-theme', next); } catch (e) { /* stockage indisponible */ }
  });
})();
