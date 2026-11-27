# Reconnecter composant orphelin (plugin Penpot 2.17)

Port du skill `penpot-reconnect-orphans` v0.9.4. Interface « Lanterne » (reprise de « C'est les ténèbres »), en français.
Aucune donnée n'est envoyée à l'extérieur : le code ne contient aucun appel réseau (vérifié par recherche de `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`). Les seules URL sont celles de l'hébergement du plugin lui-même.

## Fichiers à publier (racine du dépôt)
`manifest.json`, `plugin-v8.js`, `ui-v8.html`, `ui-v8.css`, `ui-v8.js`, dossier `fonts/`.
Pour forcer Penpot à recharger : renommer en `-v9` (manifest, plugin, ui), désinstaller puis réinstaller. Ne jamais changer `"version"` du manifest (format du manifest, valeur 1).

## Fonctions
1. **Lister** les racines orphelines (page ou sélection), groupées par nom, avec la **source probable** : correspondance exacte chemin + nom, sinon candidats approchés (similarité de nom, comparaison du nombre de nœuds, niveau de confiance). Variantes : choix par signature, sinon les plus proches avec leurs écarts.
2. **Reconnecter** en conservant textes, icônes échangées, couleurs et tokens, visibilité, opacité, police, réglages de mise en page.
3. **Aperçu avant / après** (PNG de l'orphelin et d'une instance temporaire du composant avec les valeurs reportées) et **rapport** des éléments non reconnectés, avec action conseillée (.txt / .json).
4. **Lot** avec confirmation (2e clic), arrêt à la première erreur, bouton **Interrompre**, et annulation : Ctrl+Z en un seul bloc (méthode « En place », si l'API le permet) ou « Annuler le lot » (méthode « Remplacement »).

## Méthodes
- **En place** (défaut) : `swapComponent` sur la racine existante (même id, parent, index, interactions). Sonde sur un clone avant chaque reconnexion ; une version du fichier est enregistrée avant la première.
- **Remplacement** : instance neuve du bon composant, substituée à l'orphelin (nouvel id), orphelin masqué puis supprimé ; entièrement annulable avant validation.

## Limites
Non validé dans un plugin : sous-instances échangées sur un original, orphelins imbriqués, thème. Le rayon, le padding et la police des variantes ne sont pas réappliqués. `swapComponent` et l'historique (`undoBlockBegin`) ne figurent pas dans les extraits de documentation consultés : leur présence repose sur les mesures du skill (Penpot 2.17.2) et sur une détection à l'exécution.
