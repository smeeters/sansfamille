# Reconnecter les orphelins (plugin Penpot)

Port du skill `penpot-reconnect-orphans` v0.9.4. Interface « Lanterne » reprise de « C'est les ténèbres ».

## Fichiers à publier (racine du dépôt)
`manifest.json`, `plugin-v5.js`, `ui-v5.html`, `ui-v5.css`, `ui-v5.js`, dossier `fonts/`.
Pour forcer Penpot à recharger : renommer en `-v6` (manifest, plugin, ui). Ne jamais changer `"version"` du manifest (format du manifest, valeur 1).

## Usage
1. Périmètre : **Page** (tout) ou **Sélection** (ce qui est sélectionné).
2. « Sauvegarder une version », puis « Scanner ».
3. Reconstruire : une racine, un composant (bouton du groupe) ou tout le lot. Le lot s'arrête à la première erreur.
4. Contrôler à l'œil, puis « Valider » (supprime l'orphelin) ou « Annuler » (supprime l'instance neuve). « Valider le lot » supprime tout en une fois, les `remove()` en dernier.

## Garde-fous
Jamais de swap brut ni de detach · match exact · variante par signature (0 écart) ou choix manuel signalé · racines orphelines uniquement · remplacement en étapes (insertion, vérification, suppression).

## Limites
Non validé : sous-instances échangées sur un original, orphelins imbriqués, thème. Le rayon, le padding et la police ne sont pas réappliqués.
