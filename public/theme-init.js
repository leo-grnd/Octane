// Applique le thème enregistré avant le premier rendu, pour éviter un flash
// clair chez un visiteur en thème sombre. Chargé SANS defer ni async dans le
// <head> de chaque page, avant les feuilles de style.
//
// Fichier externe plutôt que script en ligne : la Content-Security-Policy
// (_headers) n'autorise aucun script en ligne. Convention partagée avec app.js,
// alertes.js et theme-toggle.js : le clair est le défaut, seul le sombre pose
// data-theme="dark" sur <html>, choix mémorisé sous la clé « octane-theme ».
(function () {
  try {
    var t = localStorage.getItem('octane-theme') ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  } catch (e) { /* stockage indisponible : thème clair par défaut */ }
})();
