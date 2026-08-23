# ShadeFirst 80 — spike de données

Date d’extraction : **4 août 2026**  
Verdict : **PIVOT / BLOCKED — ne pas construire l’interface**

## Décision en une phrase

Les arrêts, coordonnées, lignes et données de fréquentation sont suffisamment propres pour prototyper une priorisation, mais **aucune source publique testée ne permet d’identifier fiablement les arrêts déjà équipés d’un abri**. Le test thermique FortyGuard est prêt, mais bloqué tant que la clé Premium n’a pas été reçue.

ShadeFirst 80 ne peut donc pas encore promettre « les 80 arrêts à équiper ». Au mieux, l’état actuel permettrait « les arrêts à auditer en priorité ».

## 1. Fraîcheur et remplissage

### City of Phoenix — Bus Stops

Source officielle : [ArcGIS MapServer Phoenix](https://maps.phoenix.gov/pub/rest/services/Public/BusStops/MapServer/0)

| Contrôle | Résultat |
|---|---:|
| Arrêts | 4 104 |
| `STOP_ID` renseigné et unique | 4 104 — 100 % |
| Coordonnées valides | 4 104 — 100 % |
| `NEXTRIDEID` renseigné | 4 088 — 99,61 % |
| `RIDERSHIP` renseigné | 4 029 — 98,17 % |
| `NBR_SHELTERS` renseigné | **20 — 0,49 %** |
| `NBR_SHELTERS` nul | **4 084 — 99,51 %** |

La couche ne publie ni `lastEditDate`, ni période, ni unité pour `RIDERSHIP`. Sa fraîcheur ne peut donc pas être prouvée. La distribution observée est : médiane 9, P90 65, P99 ≈173, maximum 609.

### Valley Metro — Bus Stops with Amenities

Source officielle et marquée `Authoritative` : [Feature Service Valley Metro](https://services2.arcgis.com/2t1927381mhTgWNC/arcgis/rest/services/BusStopsWAmenities/FeatureServer/0)

- description : **stops effective July 2026** ;
- dernière édition publiée : **27 juillet 2026** ;
- 4 289 arrêts rattachés à Phoenix, dont 4 288 actifs ;
- identifiants, coordonnées et lignes remplis ;
- champ entier `Shelters` positif : **0 arrêt** ;
- champ texte `Shelter = 1` : **1 arrêt** ;
- champ `Shade` vide ou nul partout.

Ces valeurs sont impossibles à interpréter comme un inventaire réel. Le bilan officiel Shade Phoenix indique **3 164 arrêts avec abri, soit 78 %**, après 81 nouvelles installations sur l’exercice 2024–2025. [Bilan officiel Shade Phoenix](https://storymaps.arcgis.com/stories/fc03d8a6a86e4f998169205dc8705e56)

### Ancien service Valley Metro

L’ancien service contient une table `BusStopAmenities`, mais :

- données des arrêts arrêtées en mars 2023 ;
- table d’équipements arrêtée en décembre 2022 ;
- seulement 3 enregistrements d’abris attribués à Phoenix ;
- les photos sont absentes ou vides pour l’immense majorité des arrêts Phoenix.

Il n’est ni assez frais ni assez rempli pour reconstruire l’inventaire manquant.

## 2. Jointure réalisée

Clé retenue : `Valley Metro stop_id` → `Phoenix STOP_ID`. Aucune jointure géographique n’est nécessaire pour le chemin nominal.

| Contrôle | Résultat |
|---|---:|
| Correspondances exactes | 4 072 |
| Couverture de la couche Phoenix | **99,22 %** |
| Couverture des arrêts actifs Valley Metro | 94,96 % |
| Phoenix non appariés | 32 |
| Valley Metro actifs non appariés | 216 |
| Écart géographique médian des appariés | 0,04 m |
| Écart géographique P95 | 0,06 m |

La jointure est techniquement saine. Les 216 arrêts Valley Metro sans `RIDERSHIP` Phoenix sont probablement des ajouts ou différences de périmètre, mais l’absence de date sur la fréquentation empêche de le confirmer.

Livrables produits :

- `outputs/joined_phoenix_stops.csv` — 4 288 arrêts actifs ;
- `outputs/fortyguard_10_stop_panel.csv` — panel de falsification ;
- `outputs/spike_metrics.json` — mesures reproductibles ;
- `scripts/analyze_shadefirst.py` — reconstruction complète du contrôle.

## 3. Test FortyGuard préparé

Documentation officielle : [Heatmap](https://docs-api.fortyguard.com/docs/create-heatmap), [limites](https://docs-api.fortyguard.com/docs/limitations), [authentification](https://docs-api.fortyguard.com/docs/authentication)

Le panel contient 10 arrêts à forte fréquentation, répartis dans un rectangle d’environ **34,89 mi²**, sous la limite Premium documentée de 50 mi². La distance minimale entre deux arrêts est 1,665 km : ils devraient tomber dans des cellules distinctes à 60 m.

Le runner `scripts/run_fortyguard_probe.py` :

1. soumet trois heatmaps `tcm` à 11 h, 14 h et 17 h ;
2. utilise la granularité minimale documentée de 60 m ;
3. suit les activités asynchrones ;
4. détecte le nom réel de la propriété température ;
5. fait la jointure point-dans-polygone ;
6. calcule `P90 − P10` et la stabilité du classement ;
7. rend un gate automatique.

Commande lorsque la clé est disponible :

```bash
export FORTYGUARD_API_KEY='…'
python3 scripts/run_fortyguard_probe.py
```

État du 4 août : **aucune clé FortyGuard dans l’environnement et aucun nouvel email contenant une clé**. Le runner s’arrête avant toute requête et affiche `BLOCKED`.

## 4. Gates

### Signal FortyGuard

- `GO_THERMAL_SIGNAL` : 10/10 valeurs, au moins 8 cellules distinctes, `P90 − P10 ≥ 1,5 °C` sur au moins deux horaires et Spearman médian ≥0,6.
- `GO_CONDITIONAL_FACTOR_ONLY` : dispersion maximale entre 0,75 et 1,5 °C ; FortyGuard reste un facteur secondaire.
- `NO_GO_THERMAL_SIGNAL` : valeurs manquantes, cellules non distinctes, dispersion <0,75 °C ou classement instable.

Important : la maille API minimale documentée est **60 m**, largement supérieure à l’emprise d’un abri. Même avec un bon signal, FortyGuard pourra mesurer le risque thermique du secteur, **pas prouver l’effet thermique de l’abri lui-même**.

### Produit

| Décision | Condition |
|---|---|
| **GO ShadeFirst 80** | Inventaire complet et frais des abris + fréquentation datée + signal FortyGuard utile + faisabilité terrain |
| **PIVOT Shade Survey** | Signal FortyGuard utile, inventaire des abris absent : prioriser les inspections |
| **PIVOT Cool Corridors** | Signal à l’échelle quartier/corridor, mais insuffisant à l’échelle arrêt |
| **STOP** | Pas d’inventaire scalable et FortyGuard ne modifie pas réellement le classement |

## 5. Recommandation

1. **Geler toute nouvelle interface.**
2. Obtenir la clé Premium et lancer le panel préparé.
3. Demander sur Slack à FortyGuard/Phoenix s’ils disposent d’un inventaire d’abris exploitable, ou accepter que le produit devienne un outil de priorisation d’inspections.
4. Ne verrouiller le projet qu’après le résultat thermique.

Position actuelle : **ShadeFirst 80 n’est pas validé.** Le pivot le plus crédible à ce stade est **Shade Survey**, sauf si un inventaire fiable des 3 164 arrêts équipés apparaît.
