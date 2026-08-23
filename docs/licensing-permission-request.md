# Licensing permission request — sent, replies pending

> **Status: sent on 2026-08-23 from `dcredoz@leadalpes.fr`; replies pending.**
> The City request was sent to `mapservices@phoenix.gov` with
> `contactus@phoenix.gov` copied. The Valley Metro request was sent to
> `csr@valleymetro.org`. Record each reply, its date, the sender's authority and
> the exact scope before changing the licensing gate.

Two exact-item grants already permit the current and legacy Valley Metro bus-stop
layers. The remaining questions concern:

- City of Phoenix `BusStops/MapServer/0` → `data/raw/phoenix_bus_stops.geojson`;
- Valley Metro `BusRidershipByQuarterForPortal/FeatureServer/6` →
  `data/raw/valley_metro_quarterly_ridership.json`.

The generated Phoenix stop dataset carries transformed values from both sources.
Permission must therefore cover the raw extract **and** public redistribution of
the processed per-stop fields; deleting only the raw input does not settle that
second question.

## Draft 1 — City of Phoenix GIS

**Suggested recipient:** `mapservices@phoenix.gov`
**Alternative permission contact published by the City:** `contactus@phoenix.gov`

**Subject:** Permission to redistribute City of Phoenix BusStops GIS extract in a public hackathon repository

Hello,

I am building a non-commercial Phoenix transit heat-operations pilot for the
FortyGuard Hackathon. The public repository is:

https://github.com/Damso74/fortyguard-heat-priority-engine

The project downloaded a GeoJSON extract from this exact public service:

https://maps.phoenix.gov/pub/rest/services/Public/BusStops/MapServer/0

The repository currently contains the raw extract
`data/raw/phoenix_bus_stops.geojson` and a generated per-stop dataset that retains
selected transformed fields for provenance and cross-checking. The City of
Phoenix is attributed, the data is presented as-is, and no City endorsement is
claimed.

Could an authorised City data/GIS representative please confirm in writing
whether we may:

1. reproduce and publicly redistribute the downloaded GeoJSON extract in the
   GitHub repository;
2. transform it and publicly redistribute selected per-stop values in generated
   JSON/CSV artefacts and the read-only demo; and
3. retain those materials for reproducibility after the hackathon?

If permission is granted, please state any required attribution, licence text or
other conditions. If this mailbox is not the data owner, please route the request
to the person authorised to answer for this specific service.

Thank you.

## Draft 2 — Valley Metro ridership data

**Suggested first contact:** `csr@valleymetro.org`, asking to route the message to
the GIS/open-data owner for ArcGIS organisation `2t1927381mhTgWNC`.

**Subject:** Permission to redistribute Valley Metro quarterly bus-stop ridership data in a public hackathon repository

Hello,

I am building a non-commercial Phoenix transit heat-operations pilot for the
FortyGuard Hackathon. The public repository is:

https://github.com/Damso74/fortyguard-heat-priority-engine

The project downloaded Phoenix records from this exact public ArcGIS item/service:

https://www.arcgis.com/home/item.html?id=3f5363e04eb74869aa9c67079318719f

https://services2.arcgis.com/2t1927381mhTgWNC/arcgis/rest/services/BusRidershipByQuarterForPortal/FeatureServer/6

The item is public but its `licenseInfo` field is empty. The repository currently
contains the raw JSON extract and a generated per-stop dataset containing selected
quarterly average weekday/weekend values. Valley Metro is attributed, the values
are labelled with their period and limitations, and no Valley Metro endorsement
is claimed.

Could an authorised Valley Metro data/GIS representative please confirm in
writing whether we may:

1. reproduce and publicly redistribute the downloaded JSON extract in the GitHub
   repository;
2. transform it and publicly redistribute selected per-stop quarterly values in
   generated JSON/CSV artefacts and the read-only demo; and
3. retain those materials for reproducibility after the hackathon?

If permission is granted, please state any required attribution, licence text or
other conditions. If this mailbox is not the data owner, please route the request
to the person authorised to answer for this exact ArcGIS item.

Thank you.

## Evidence to retain after replies

- full message thread or signed permission, not a paraphrase;
- sender name, role and organisational address;
- exact raw and derived scope granted;
- attribution/notice required;
- commercial/non-commercial restriction, duration and revocation terms;
- date reviewed and the repository commit that implements the decision.

Until both unresolved sources are answered, the submission gate remains
`NO-GO`. A reply that permits viewing or analysis but not redistribution does not
clear it.
