import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface LayerInfo {
  id: string;
  file: string;
  type: 'geojson' | 'gpkg';
  url: string;
}

export interface LayersResponse {
  count: number;
  layers: LayerInfo[];
}

@Injectable({ providedIn: 'root' })
export class GeoService {
  private http = inject(HttpClient);
  private apiUrl = environment.apiUrl;

  getLayers(): Observable<LayersResponse> {
    return this.http.get<LayersResponse>(`${this.apiUrl}/geo/layers`);
  }

  getLayer(id: string): Observable<any> {
    return this.http.get<any>(`${this.apiUrl}/geo/layer/${id}`);
  }

  getGtfsFiles(): Observable<any> {
    return this.http.get<any>(`${this.apiUrl}/gtfs/files`);
  }

  getGtfsData(file: string, limit = 1000, offset = 0): Observable<any> {
    return this.http.get<any>(
      `${this.apiUrl}/gtfs/${file}?limit=${limit}&offset=${offset}`
    );
  }
}
