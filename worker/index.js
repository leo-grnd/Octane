// Worker d'Octane. Il ne reçoit que les requêtes /api/* (run_worker_first dans
// wrangler.jsonc) : tout le reste est servi directement depuis les fichiers
// statiques, sans l'invoquer. Les routes des alertes en libre-service arrivent
// avec la phase D ; d'ici là, toute route d'API répond 404.
//
// Module ES sans dépendance, comme le reste du projet.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Une réponse d'API ne doit jamais être mise en cache, ni par le
      // navigateur ni par le service worker.
      'Cache-Control': 'no-store'
    }
  });

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) {
      return json({ error: 'not_found' }, 404);
    }
    // Filet de sécurité : n'est atteint que si la configuration envoie un jour
    // d'autres chemins au Worker.
    return env.ASSETS.fetch(request);
  }
};
