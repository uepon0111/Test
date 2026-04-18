import { LucideIcon } from 'lucide-react';

export type Orientation = 'horizontal' | 'vertical';

export interface Point {
  x: number;
  y: number;
}

export interface Station {
  id: string;
  name: string;
  x: number;
  y: number;
  platforms: number;
  orientation: Orientation;
}

export interface TrackSegment {
  id: string;
  start: Point;
  end: Point;
  travelTime: number; // minutes per grid unit? User said "1マスあたりの所要時間"
}

export interface RouteStep {
  type: 'station' | 'branch' | 'track';
  id: string; // stationId or node coordinate string
  platformIndex?: number; // for station
  arrivalTime: number; // minutes from start of day
  departureTime?: number; // minutes from start of day
  direction: string; // text for UI
}

export interface TrainPattern {
  id: string;
  name: string;
  color: string;
  startTime: number; // minutes from midnight (0:00)
  interval: number; // repeat interval in minutes
  steps: RouteStep[]; // sequence of path points/stations
}

export interface SimulationState {
  currentTime: number; // minutes from midnight
  speed: number;
  isPlaying: boolean;
}

export interface AppData {
  stations: Station[];
  tracks: TrackSegment[];
  trains: TrainPattern[];
}
