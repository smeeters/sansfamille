# Reconnecter les orphelins (plugin Penpot)

Port du skill `penpot-reconnect-orphans` v0.9.4.

## Installation
1. Publier le dossier à la racine d'un dépôt public avec GitHub Pages (ou servir en local, en remplaçant les URL absolues de manifest.json et plugin.js).
2. Penpot → Plugins → Installer → `http://localhost:4400/manifest.json`.

## Usage
1. « Sauvegarder une version » (filet de sécurité).
2. « Scanner la page » : racines orphelines, match path+name, match de variante par signature.
3. Par racine : « Aperçu du delta », puis « Reconstruire » (instance neuve + overrides : textes, icônes échangées, fills/strokes avec tokens, visibilité, opacité, police, layoutChild ; insérée à l'index de l'orphelin).
4. Contrôler visuellement, puis « Valider » (supprime l'orphelin) ou « Annuler » (supprime l'instance neuve).

## Garde-fous repris du skill
- Jamais de swap brut ni de detach.
- Match exact exigé ; variantes choisies par signature (0 écart), variante liée ≠ demandée = STOP.
- Racines orphelines uniquement ; parent dans un sous-arbre orphelin = refus.
- Suppression de l'orphelin en dernier, jamais dans le même passage que l'insertion.
- Structure divergente ou source introuvable : rien n'est modifié.

## Limites
- Non testé dans Penpot : à essayer d'abord sur un clone, une racine à la fois.
- Orphelins imbriqués : traités avec leur racine externe.
- Tokens : seuls les fills/strokes avec `*RefId` sont repris (pas `shape.tokens`).

