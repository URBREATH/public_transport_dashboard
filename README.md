# Public Transport Accessibility Dashboard 

**Provided by:** Deda next

---
The public transport accessibility analysis measures how well residents can access the public transport network, and visualizes covered and uncovered population and identifies transit desert areas. 
The analysis used GTFS data and Copernicus GHS population data. The result is a Python-based proof of concept (POC), inspired by the QGIS GTFS2GIS plugin (https://github.com/arrobaraujo/qgis_gtfs_plugin) and tailored for dashboard visualization. 

---

## What The Dashboard Visualizes

Given a city's GTFS data (multiple or not) and GHS-population data clipped to the city's administrative boundaries, the dashboard visualizes:

- **Transport stops**: transport stops visualized using different thematizations (e.g. average hourly frequency, number of served lines) and categorized by service type (route type in GTFS data, for example: bus,metro,tram).
- **Transport lines**: transport lines visualized using different thematizations.
- **Transport stop accessibility**: output of the "15 minutes city" tool (hexagonal grid with walking time to reach the transport stops).
- **Heatmap frequency**: heatmap of the average daily passages.
- **Transit deserts**: populated areas not covered by the public transport network within walking distance (400m) from a transport stop.
- **Population coverage**: combines GTFS data and GHS population data to estimate the number and percentage of residents covered and not covered.
- **Population 2025**: Copernicus population dataset GHS_POP_E2025_GLOBE_R2023A (https://human-settlement.emergency.copernicus.eu/ghs_pop2023.php).
- **KPI**:
  - **Total area**: surface of the city area under analysis (km²).
  - **Total stops**: number of public transport stops.
  - **Stop density**: density of stops per km².
  - **Avg km/day**: average network kilometers travelled per day (total trip km / service days).
  - **Avg trips/day**: average number of trips run per day.
  - **Total lines**: number of public transport lines.
  - **Pop tot**: population in the area (from GHS_POP_E2025_GLOBE_R2023A).
  - **Pop uncovered**: population NOT covered (residents outside the walking reach from stops).
  - **Date range**: range of service validity dates covered by the GTFS data (from calendar.txt, start date → end date).
  - **Agencies**: list of transport agencies/operators present in the GTFS data.
- **Charts**:
  - **Accessibility zones**: % of grid cells by accessibility level.
  - **Cumulative accessibility**: % of area reachable within X minutes.
  - **Transit desert**: desert areas by population size.
  - **Population covered vs uncovered**: residents with and without transport services.
  - **Stops by number of lines**: how many lines serve each stop.
  - **Top 10 interchange hubs**: stops serving the most lines.
  - **Avg trips per hour**: mean number of trips each hour.
- **Feature info**:
  - **Transport stops**: displays the stop ID, average hourly frequency, total served lines, and line list.
  - **Transport lines**: displays the lines crossing the selected location and their destinations.
  - **Transport stop accessibility**: displays the walking time to the nearest public transport stop.
  - **Heatmap frequency**: displays the average number of daily trips for the selected network segment.
  - **Transit deserts**: displays the number of residents not covered by public transport.
  - **Population coverage**: displays the number of covered and uncovered residents and the corresponding coverage percentage.
- **Basemap** (possibility to change the basemap):
  - Esri light gray
  - Esri dark gray
  - OSM standard
  - Esri world imagery



## Contact

- chiara.savoldi@dedagroup.it  
- martina.forconi@dedagroup.it  

---
