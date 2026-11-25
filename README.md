# Reconnecter les orphelins (plugin Penpot)

Port du skill `penpot-reconnect-orphans` v0.9.4. Interface « Lanterne » reprise de « C'est les ténèbres ».

## Fichiers à publier (racine du dépôt)
`manifest.json`, `plugin-v7.js`, `ui-v7.html`, `ui-v7.css`, `ui-v7.js`, dossier `fonts/`.
Pour forcer Penpot à recharger : renommer en `-v8` (manifest, plugin, ui) puis désinstaller / réinstaller le plugin. Ne jamais changer `"version"` du manifest (format du manifest, valeur 1).

## Méthodes
- **En place (défaut)** : la racine existante est reconnectée au bon composant. Même id, même parent, même index, mêmes interactions, pas de doublon. Étapes : valeurs enregistrées (fichier JSON) → sonde sur un clone (si la racine y est détruite ou mal liée : arrêt, rien n'est modifié) → `swapComponent` → valeurs réappliquées (textes, icônes, couleurs/tokens, visibilité, opacité, police, layoutChild) → vérification. Une version du fichier est enregistrée avant la première reconnexion.
- **Remplacement (secours)** : instance neuve du bon composant, substituée à l'orphelin (nouvel id), orphelin masqué puis supprimé. À utiliser quand la sonde refuse la méthode en place.

## Usage
Périmètre Page ou Sélection → Scanner → Reconnecter (une racine, un composant, ou le lot), confirmation par 2e clic. Le lot s'arrête à la première erreur.

## Limites
Non validé : sous-instances échangées sur un original, orphelins imbriqués, thème. Le rayon, le padding et la police des variantes ne sont pas réappliqués. Le swap en place ne peut pas être annulé par le plugin : Ctrl+Z ou restauration de la version.
