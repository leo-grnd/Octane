// En-tête commun à toutes les pages : bascule clair / sombre et menu mobile.
// Chargé en defer par chaque page. Le thème enregistré est déjà appliqué avant
// le premier rendu par theme-init.js (même convention : le clair est le défaut,
// seul le sombre pose data-theme="dark" sur <html>, choix mémorisé sous la clé
// « octane-theme »). Les icônes soleil / lune et burger / croix basculent en
// CSS, d'après data-theme et aria-expanded : rien à redessiner ici.
(function () {
  var root = document.documentElement;

  var themeBtn = document.getElementById('themeToggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      if (next === 'dark') root.setAttribute('data-theme', 'dark');
      else root.removeAttribute('data-theme');
      try { localStorage.setItem('octane-theme', next); } catch (e) { /* stockage indisponible */ }
    });
  }

  // Menu burger (écrans de moins de 640 px) : les liens de l'en-tête passent
  // dans un panneau déroulant, fermé par un clic ailleurs, Échap, ou le retour
  // à une largeur où les liens tiennent dans la barre.
  var menuBtn = document.getElementById('menuToggle');
  var menu = document.getElementById('navMenu');
  if (!menuBtn || !menu) return;

  function isOpen() { return menuBtn.getAttribute('aria-expanded') === 'true'; }
  function setOpen(open) {
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.setAttribute('aria-label', open ? 'Fermer le menu' : 'Ouvrir le menu');
    menu.classList.toggle('is-open', open);
  }

  menuBtn.addEventListener('click', function () { setOpen(!isOpen()); });
  document.addEventListener('click', function (e) {
    if (isOpen() && !menu.contains(e.target) && !menuBtn.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen()) { setOpen(false); menuBtn.focus(); }
  });
  var wide = matchMedia('(min-width: 640px)');
  var onWide = function () { if (wide.matches) setOpen(false); };
  if (wide.addEventListener) wide.addEventListener('change', onWide);
  else if (wide.addListener) wide.addListener(onWide);
})();
