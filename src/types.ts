/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type Point = {
  x: number;
  y: number;
};

export type Station = {
  id: string;
  name: string;
  gx: number; // grid x
  gy: number; // grid y
  platforms: number;
  isVertical: boolean;
};

export type TrackNode = {
  id: string;
  gx: number;
  gy: number;
  stationId?: string;
  platformIndex?: number;
  nodeSide?: 'start' | 'end';
};

export type TrackSegment = {
  id: string;
  fromId: string;
  toId: string;
  timePerGrid: number; // 1マスあたりの所要秒数
};

export type StopAction = 'stop' | 'pass';

export type RouteStep = {
  nodeId: string;
  action: StopAction;
  arrivalTime: number; // 始発からの経過秒数
  departureTime: number; // 同上
  platformIndex?: number;
  branchDirection?: number; // 分岐選択 (0, 1, 2)
};

export type Train = {
  id: string;
  name: string;
  color: string;
  interval: number; // 折り返し間隔（秒）
  route: RouteStep[]; // 往路の経路
  reverseRoute: RouteStep[]; // 復路の経路 (自動生成または手動調整)
};

export type AppState = {
  stations: Station[];
  tracks: TrackSegment[];
  nodes: TrackNode[];
  trains: Train[];
};

export type SimulationState = {
  currentTime: number; // 0:00:00 からの経過秒数
  isPlaying: boolean;
  speed: number; // 倍速
};
