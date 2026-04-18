/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  Train as TrainIcon, 
  Map as MapIcon, 
  GitBranch, 
  Clock, 
  Play, 
  Pause, 
  RotateCcw, 
  Plus, 
  Trash2, 
  ChevronUp, 
  ChevronDown,
  Settings,
  Save,
  Download,
  Upload,
  ArrowRightLeft
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  AppState, 
  Station, 
  TrackNode, 
  TrackSegment, 
  Train, 
  SimulationState, 
  RouteStep 
} from './types';
import { 
  GRID_SIZE, 
  COLORS 
} from './constants';
import { 
  loadState, 
  saveState, 
  formatTime, 
  getDistance 
} from './store';

// --- Sub-components (Drafts) ---

export default function App() {
  const [appData, setAppData] = useState<AppState>(loadState());
  const [sim, setSim] = useState<SimulationState>({
    currentTime: 8 * 3600, // 08:00 start
    isPlaying: false,
    speed: 1
  });
  const [activeTab, setActiveTab] = useState<'station' | 'track' | 'dia' | 'run'>('run');
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const [selectedEntity, setSelectedEntity] = useState<{ type: string, id: string } | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(true);

  // Auto-save
  useEffect(() => {
    saveState(appData);
  }, [appData]);

  // Simulation loop
  const lastTickRef = useRef<number>(0);
  useEffect(() => {
    if (!sim.isPlaying) return;

    let frameId: number;
    const tick = (timestamp: number) => {
      if (lastTickRef.current === 0) lastTickRef.current = timestamp;
      const delta = (timestamp - lastTickRef.current) / 1000;
      lastTickRef.current = timestamp;

      setSim(prev => ({
        ...prev,
        currentTime: prev.currentTime + delta * prev.speed
      }));

      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frameId);
      lastTickRef.current = 0;
    };
  }, [sim.isPlaying, sim.speed]);

  // Mapping stations to nodes
  const getStationNodes = useCallback((station: Station): TrackNode[] => {
    const nodes: TrackNode[] = [];
    for (let i = 0; i < station.platforms; i++) {
      if (station.isVertical) {
        // Top and Bottom
        nodes.push({ id: `${station.id}-p${i}-s`, gx: station.gx, gy: station.gy + i, stationId: station.id, platformIndex: i, nodeSide: 'start' });
        nodes.push({ id: `${station.id}-p${i}-e`, gx: station.gx + 1, gy: station.gy + i, stationId: station.id, platformIndex: i, nodeSide: 'end' });
      } else {
        // Left and Right
        nodes.push({ id: `${station.id}-p${i}-s`, gx: station.gx, gy: station.gy + i, stationId: station.id, platformIndex: i, nodeSide: 'start' });
        nodes.push({ id: `${station.id}-p${i}-e`, gx: station.gx + 1, gy: station.gy + i, stationId: station.id, platformIndex: i, nodeSide: 'end' });
      }
    }
    return nodes;
  }, []);

  // Helper: Find node position
  const getNodePos = (nodeId: string): { x: number, y: number } => {
    // Check free nodes
    const node = appData.nodes.find(n => n.id === nodeId);
    if (node) return { x: node.gx * GRID_SIZE, y: node.gy * GRID_SIZE };
    
    // Check station nodes
    for (const s of appData.stations) {
      const snodes = getStationNodes(s);
      const snode = snodes.find(n => n.id === nodeId);
      if (snode) return { x: snode.gx * GRID_SIZE, y: snode.gy * GRID_SIZE };
    }
    return { x: 0, y: 0 };
  };

  // --- Simulation Helpers ---
  const getTrainPosition = (train: Train, time: number): { x: number, y: number } | null => {
    if (train.route.length < 2) return null;

    const startRouteTime = train.route[0].departureTime;
    const endRouteTime = train.route[train.route.length - 1].arrivalTime;
    const returnStart = train.reverseRoute[0]?.departureTime || endRouteTime + 60;
    const returnEnd = train.reverseRoute[train.reverseRoute.length - 1]?.arrivalTime || returnStart + 60;
    
    const cycleDuration = (returnEnd - startRouteTime) + train.interval;
    const t = ((time - startRouteTime) % cycleDuration + cycleDuration) % cycleDuration;
    const absT = startRouteTime + t;

    // Check Outbound
    for (let i = 0; i < train.route.length; i++) {
      const step = train.route[i];
      // At station stop
      if (absT >= step.arrivalTime && absT <= step.departureTime) {
        return getNodePos(step.nodeId);
      }
      // Between i and i+1
      if (i < train.route.length - 1) {
        const next = train.route[i + 1];
        if (absT > step.departureTime && absT < next.arrivalTime) {
          const p1 = getNodePos(step.nodeId);
          const p2 = getNodePos(next.nodeId);
          const ratio = (absT - step.departureTime) / (next.arrivalTime - step.departureTime);
          return {
            x: p1.x + (p2.x - p1.x) * ratio,
            y: p1.y + (p2.y - p1.y) * ratio
          };
        }
      }
    }

    // Check Inbound
    for (let i = 0; i < train.reverseRoute.length; i++) {
        const step = train.reverseRoute[i];
        if (absT >= step.arrivalTime && absT <= step.departureTime) {
          return getNodePos(step.nodeId);
        }
        if (i < train.reverseRoute.length - 1) {
          const next = train.reverseRoute[i + 1];
          if (absT > step.departureTime && absT < next.arrivalTime) {
            const p1 = getNodePos(step.nodeId);
            const p2 = getNodePos(next.nodeId);
            const ratio = (absT - step.departureTime) / (next.arrivalTime - step.departureTime);
            return {
              x: p1.x + (p2.x - p1.x) * ratio,
              y: p1.y + (p2.y - p1.y) * ratio
            };
          }
        }
    }

    // Must be waiting at start or end
    return getNodePos(train.route[0].nodeId);
  };

  // --- Handlers ---
  const autoCalculateTimes = (trainId: string, route: RouteStep[]) => {
    let currentSec = route[0]?.departureTime || 0;
    const newRoute = [...route];
    
    for (let i = 1; i < newRoute.length; i++) {
        const prev = newRoute[i-1];
        const curr = newRoute[i];
        
        // Find track between prev and curr
        const track = appData.tracks.find(t => 
            (t.fromId === prev.nodeId && t.toId === curr.nodeId) ||
            (t.toId === prev.nodeId && t.fromId === curr.nodeId)
        );
        
        if (track) {
            const p1 = getNodePos(prev.nodeId);
            const p2 = getNodePos(curr.nodeId);
            const dist = getDistance(p1.x / GRID_SIZE, p1.y / GRID_SIZE, p2.x / GRID_SIZE, p2.y / GRID_SIZE);
            const travelTime = Math.round(dist * track.timePerGrid);
            
            curr.arrivalTime = prev.departureTime + travelTime;
            curr.departureTime = curr.arrivalTime + 60; // 1 min stop by default
        }
    }
    return newRoute;
  };

  const handleMapClick = (e: React.MouseEvent<SVGSVGElement>) => {
    // ... same as before but handle track connection
    const svg = e.currentTarget;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgP = pt.matrixTransform(svg.getScreenCTM()?.inverse());
    
    const gx = Math.round(svgP.x / GRID_SIZE);
    const gy = Math.round(svgP.y / GRID_SIZE);

    if (activeTab === 'station') {
      const id = Date.now().toString();
      setAppData(prev => ({
        ...prev,
        stations: [...prev.stations, {
          id,
          name: `駅${prev.stations.length + 1}`,
          gx,
          gy,
          platforms: 2,
          isVertical: false
        }]
      }));
    } else if (activeTab === 'track') {
      // Find if clicking near a node or station end
      const clickedStationNode = appData.stations.flatMap(s => getStationNodes(s))
        .find(n => Math.abs(n.gx - gx) < 0.5 && Math.abs(n.gy - gy) < 0.5);
      
      const clickedFreeNode = appData.nodes.find(n => Math.abs(n.gx - gx) < 0.5 && Math.abs(n.gy - gy) < 0.5);
      
      const targetNodeId = clickedStationNode?.id || clickedFreeNode?.id;

      if (selectedEntity?.type === 'node' && targetNodeId && selectedEntity.id !== targetNodeId) {
        // Create track
        setAppData(prev => ({
          ...prev,
          tracks: [...prev.tracks, {
            id: `track-${Date.now()}`,
            fromId: selectedEntity.id,
            toId: targetNodeId,
            timePerGrid: 60 // default 60s
          }]
        }));
        setSelectedEntity({ type: 'node', id: targetNodeId });
      } else if (targetNodeId) {
        setSelectedEntity({ type: 'node', id: targetNodeId });
      } else {
        // Add free node
        const id = `node-${Date.now()}`;
        setAppData(prev => ({
          ...prev,
          nodes: [...prev.nodes, { id, gx, gy }]
        }));
        setSelectedEntity({ type: 'node', id });
      }
    }
  };

  const handlePan = (e: React.MouseEvent) => {
    if (e.buttons !== 1) return;
    setViewport(prev => ({
      ...prev,
      x: prev.x + e.movementX,
      y: prev.y + e.movementY
    }));
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#f8f9fa] text-[#212529]">
      {/* Top Bar */}
      <header className="h-12 bg-white border-b border-[#dee2e6] flex items-center justify-between px-6 z-30">
        <div className="flex items-center gap-3">
          <span className="font-black tracking-widest flex items-center gap-2">
            <TrainIcon size={18} className="text-[#0056b3]" />
            RAILWAY SIM <span className="font-normal text-xs opacity-50 px-2 py-0.5 border border-[#dee2e6] rounded">v0.1.2</span>
          </span>
        </div>
        
        {/* Time and Simulation Controls */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 bg-[#f8f9fa] px-3 py-1 rounded-full border border-[#dee2e6]">
            <Clock size={14} className="text-[#6c757d]" />
            <span className="font-mono text-sm font-bold">{formatTime(sim.currentTime)}</span>
          </div>
          <div className="flex items-center gap-1 bg-white border border-[#dee2e6] rounded-md p-1 shadow-sm">
            <button 
              onClick={() => setSim(p => ({ ...p, isPlaying: !p.isPlaying }))}
              className={`p-1 rounded hover:bg-gray-100 ${sim.isPlaying ? 'text-red-500' : 'text-green-600'}`}
            >
              {sim.isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
            </button>
            <div className="h-4 w-px bg-[#dee2e6]" />
            <select 
              value={sim.speed} 
              onChange={(e) => setSim(p => ({ ...p, speed: Number(e.target.value) }))}
              className="text-xs font-bold outline-none px-1"
            >
              <option value={1}>1x</option>
              <option value={10}>10x</option>
              <option value={60}>60x</option>
              <option value={300}>300x</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2 text-[11px] text-green-600 font-medium whitespace-nowrap overflow-hidden">
          <div className="hidden sm:flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            ブラウザに保存中
          </div>
          <button 
            onClick={() => alert('【操作方法】\n・駅配置/配線タブ: SHIFT + クリックで配置\n・配線タブ: 点を選択してから別の点をクリックで接続\n・ダイヤ設定: 点を選択してから「経路に追加」\n・ドラッグで移動、ホイールでズーム')}
            className="ml-2 w-5 h-5 flex items-center justify-center rounded-full border border-gray-300 text-gray-400 hover:text-blue-500 hover:border-blue-500 transition-colors"
          >
            ?
          </button>
        </div>
      </header>

      {/* Main Area */}
      <main className="flex-1 relative overflow-hidden flex flex-col md:flex-row">
        {/* Map Viewport */}
        <div className="flex-1 relative cursor-crosshair bg-[#f1f3f5]" onMouseMove={handlePan}>
          <svg 
            className="w-full h-full"
            onMouseDown={(e) => {
              if (e.button === 0 && e.shiftKey) handleMapClick(e as any);
            }}
          >
            <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.scale})`}>
              {/* Grid Lines */}
              <defs>
                <pattern id="grid" width={GRID_SIZE} height={GRID_SIZE} patternUnits="userSpaceOnUse">
                  <path d={`M ${GRID_SIZE} 0 L 0 0 0 ${GRID_SIZE}`} fill="none" stroke="#e9ecef" strokeWidth="1" />
                </pattern>
              </defs>
              <rect width="10000" height="10000" x="-5000" y="-5000" fill="url(#grid)" />

              {/* Tracks */}
              {appData.tracks.map(track => {
                const p1 = getNodePos(track.fromId);
                const p2 = getNodePos(track.toId);
                return (
                  <line 
                    key={track.id}
                    x1={p1.x} y1={p1.y}
                    x2={p2.x} y2={p2.y}
                    stroke={COLORS.rail}
                    strokeWidth={4}
                    strokeLinecap="round"
                  />
                )
              })}

              {/* Stations */}
              {appData.stations.map(station => (
                <g 
                  key={station.id} 
                  transform={`translate(${station.gx * GRID_SIZE}, ${station.gy * GRID_SIZE})`}
                  onClick={() => setSelectedEntity({ type: 'station', id: station.id })}
                >
                  <rect 
                    width={GRID_SIZE * 2} 
                    height={station.platforms * GRID_SIZE}
                    fill="white"
                    stroke={COLORS.rail}
                    strokeWidth={2}
                    rx={4}
                    className="shadow-sm"
                  />
                  {Array.from({ length: station.platforms }).map((_, i) => (
                    <line 
                      key={i}
                      x1={4} y1={(i + 0.5) * GRID_SIZE}
                      x2={GRID_SIZE * 2 - 4} y2={(i + 0.5) * GRID_SIZE}
                      stroke={COLORS.rail}
                      strokeWidth={1}
                      strokeDasharray="4 2"
                    />
                  ))}
                  <text 
                    x={GRID_SIZE} y={-10} 
                    textAnchor="middle" 
                    className="text-[10px] font-bold fill-gray-800 select-none"
                  >
                    {station.name}
                  </text>
                </g>
              ))}

              {/* Free Nodes (Helper) */}
              {(activeTab === 'track' || activeTab === 'dia') && appData.nodes.map(node => (
                <circle 
                  key={node.id}
                  cx={node.gx * GRID_SIZE}
                  cy={node.gy * GRID_SIZE}
                  r={selectedEntity?.id === node.id ? 6 : 4}
                  fill={selectedEntity?.id === node.id ? COLORS.accent : COLORS.accent + '88'}
                  className="cursor-pointer hover:r-6 transition-all"
                  onClick={() => setSelectedEntity({ type: 'node', id: node.id })}
                />
              ))}
              {(activeTab === 'track' || activeTab === 'dia') && appData.stations.flatMap(s => getStationNodes(s)).map(node => (
                 <circle 
                  key={node.id}
                  cx={node.gx * GRID_SIZE}
                  cy={node.gy * GRID_SIZE}
                  r={selectedEntity?.id === node.id ? 6 : 4}
                  fill={selectedEntity?.id === node.id ? '#28a745' : '#28a74588'}
                  className="cursor-pointer hover:r-6 transition-all"
                  onClick={() => setSelectedEntity({ type: 'node', id: node.id })}
                />
              ))}

              {/* Trains */}
              {sim.isPlaying && appData.trains.map(train => {
                const pos = getTrainPosition(train, sim.currentTime);
                if (!pos) return null;
                return (
                  <motion.g 
                    key={train.id}
                    initial={false}
                    animate={{ x: pos.x, y: pos.y }}
                    transition={{ type: 'tween', ease: 'linear', duration: 0 }}
                  >
                    <rect 
                      x={-10} y={-10} width={20} height={20}
                      fill={train.color}
                      stroke="white"
                      strokeWidth={2}
                      rx={4}
                    />
                    {/* Directional indicator could be added here */}
                  </motion.g>
                );
              })}
            </g>
          </svg>

          {/* Map Controls */}
          <div className="absolute bottom-6 left-6 flex flex-col gap-2">
            <button 
              className="w-10 h-10 bg-white rounded-lg shadow-lg flex items-center justify-center hover:bg-gray-50 border border-gray-200"
              onClick={() => setViewport(v => ({ ...v, scale: Math.min(v.scale + 0.2, 3) }))}
            >
              <Plus size={20} />
            </button>
            <button 
              className="w-10 h-10 bg-white rounded-lg shadow-lg flex items-center justify-center hover:bg-gray-50 border border-gray-200"
              onClick={() => setViewport(v => ({ ...v, scale: Math.max(v.scale - 0.2, 0.2) }))}
            >
              <div className="w-4 h-0.5 bg-black" />
            </button>
            <button 
              className="w-10 h-10 bg-white rounded-lg shadow-lg flex items-center justify-center hover:bg-gray-50 border border-gray-200"
              onClick={() => setViewport({ x: 0, y: 0, scale: 1 })}
            >
              <RotateCcw size={18} />
            </button>
          </div>

          <div className="absolute top-6 left-6 bg-white/80 backdrop-blur-sm px-3 py-1.5 rounded-md text-[10px] font-bold border border-gray-200 shadow-sm pointer-events-none">
            {activeTab === 'station' ? 'SHIFT + クリックで駅を設置' : 
             activeTab === 'track' ? 'SHIFT + クリックで経由点を設置' : 
             'ドラッグで移動 / ホイールでズーム'}
          </div>
        </div>

        {/* Info Panel / Sidebar */}
        <AnimatePresence>
          {isPanelOpen && (
            <motion.div 
              initial={{ x: 300 }}
              animate={{ x: 0 }}
              exit={{ x: 300 }}
              className="w-full md:w-80 bg-white border-l border-[#dee2e6] flex flex-col z-20 shadow-2xl md:shadow-none absolute md:static inset-0 top-auto md:h-full max-h-[70vh] md:max-h-none h-[50vh]"
            >
              <div className="p-4 border-b border-[#dee2e6] flex items-center justify-between bg-[#f8f9fa]">
                <h2 className="font-black text-sm tracking-tight flex items-center gap-2">
                  {activeTab === 'station' && <><MapIcon size={16} /> 駅配置</>}
                  {activeTab === 'track' && <><GitBranch size={16} /> 配線設定</>}
                  {activeTab === 'dia' && <><Clock size={16} /> ダイヤ設定</>}
                  {activeTab === 'run' && <><Play size={16} /> 運行状況</>}
                </h2>
                <button onClick={() => setIsPanelOpen(false)} className="md:hidden">
                  <ChevronDown size={20} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4">
                {activeTab === 'station' && (
                  <div className="space-y-4">
                    {appData.stations.length === 0 && (
                      <p className="text-xs text-gray-500 italic">まだ駅がありません。マップをシフトクリックして作成してください。</p>
                    )}
                    {appData.stations.map(st => (
                      <div key={st.id} className="p-3 border border-gray-200 rounded-lg hover:border-blue-300 transition-colors group">
                        <div className="flex items-center justify-between mb-2">
                          <input 
                            className="font-bold outline-none flex-1" 
                            value={st.name} 
                            onChange={(e) => {
                              const val = e.target.value;
                              setAppData(prev => ({
                                ...prev,
                                stations: prev.stations.map(s => s.id === st.id ? { ...s, name: val } : s)
                              }));
                            }}
                          />
                          <button 
                            onClick={() => {
                              setAppData(prev => ({
                                ...prev,
                                stations: prev.stations.filter(s => s.id !== st.id)
                              }));
                            }}
                            className="text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-2 mt-2">
                          <div className="flex flex-col">
                            <label className="text-[10px] text-gray-400 font-bold uppercase">ホーム数</label>
                            <select 
                              className="text-sm outline-none bg-gray-50 border-none rounded p-1"
                              value={st.platforms}
                              onChange={(e) => {
                                const val = Number(e.target.value);
                                setAppData(prev => ({
                                  ...prev,
                                  stations: prev.stations.map(s => s.id === st.id ? { ...s, platforms: val } : s)
                                }));
                              }}
                            >
                              {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} 番線</option>)}
                            </select>
                          </div>
                          <div className="flex flex-col">
                            <label className="text-[10px] text-gray-400 font-bold uppercase">向き</label>
                            <button 
                              onClick={() => {
                                setAppData(prev => ({
                                  ...prev,
                                  stations: prev.stations.map(s => s.id === st.id ? { ...s, isVertical: !s.isVertical } : s)
                                }));
                              }}
                              className="text-sm text-left px-2 py-1 bg-gray-50 rounded"
                            >
                              {st.isVertical ? '縦' : '横'}
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {activeTab === 'track' && (
                  <div className="space-y-4">
                    <p className="text-[11px] text-gray-500 leading-relaxed mb-4">
                      点を選択してから次の点を選択すると、線路が繋がります。
                    </p>
                    <div className="space-y-2">
                       {appData.tracks.map(track => (
                         <div key={track.id} className="p-2 border border-gray-100 rounded text-[10px] flex items-center justify-between group">
                            <span>Track: {track.id.slice(-4)}</span>
                            <div className="flex items-center gap-2">
                               <input 
                                  type="number" 
                                  className="w-12 bg-gray-50 border-none outline-none p-1 rounded font-bold"
                                  value={track.timePerGrid}
                                  onChange={(e) => {
                                    const val = Number(e.target.value);
                                    setAppData(prev => ({
                                      ...prev,
                                      tracks: prev.tracks.map(t => t.id === track.id ? { ...t, timePerGrid: val } : t)
                                    }));
                                  }}
                               />
                               <span className="text-gray-400">s/grid</span>
                               <button 
                                  onClick={() => setAppData(p => ({ ...p, tracks: p.tracks.filter(t => t.id !== track.id) }))}
                                  className="text-red-400 opacity-0 group-hover:opacity-100"
                               >
                                  <Trash2 size={12} />
                               </button>
                            </div>
                         </div>
                       ))}
                    </div>
                  </div>
                )}

                {activeTab === 'dia' && (
                  <div className="space-y-4">
                    <button 
                      onClick={() => {
                        const newTrain: Train = {
                          id: `train-${Date.now()}`,
                          name: `列車${appData.trains.length + 1}`,
                          color: '#' + Math.floor(Math.random()*16777215).toString(16),
                          interval: 600,
                          route: [],
                          reverseRoute: []
                        };
                        setAppData(prev => ({ ...prev, trains: [...prev.trains, newTrain] }));
                        setSelectedEntity({ type: 'train', id: newTrain.id });
                      }}
                      className="w-full py-2 bg-blue-600 text-white rounded-md font-bold text-sm shadow-md hover:bg-blue-700 flex items-center justify-center gap-2"
                    >
                      <Plus size={16} /> 列車を追加
                    </button>

                    <div className="space-y-3">
                      {appData.trains.map(train => (
                        <div key={train.id} className="p-3 border border-gray-200 rounded-lg">
                           <div className="flex items-center justify-between mb-3">
                              <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: train.color }} />
                                <input 
                                  className="font-bold text-sm outline-none" 
                                  value={train.name}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setAppData(prev => ({
                                      ...prev,
                                      trains: prev.trains.map(t => t.id === train.id ? { ...t, name: val } : t)
                                    }))
                                  }}
                                />
                              </div>
                              <button 
                                onClick={() => setAppData(p => ({ ...p, trains: p.trains.filter(t => t.id !== train.id) }))}
                                className="text-gray-400 hover:text-red-500"
                              >
                                <Trash2 size={14} />
                              </button>
                           </div>

                           {/* Route Steps Editor (Tab 3 UI) */}
                           <div className="space-y-0 relative pl-4 border-l-2 border-gray-100">
                              {train.route.map((step, idx) => {
                                const node = appData.nodes.find(n => n.id === step.nodeId) || appData.stations.flatMap(s => getStationNodes(s)).find(n => n.id === step.nodeId);
                                const isStation = !!node?.stationId;
                                const stationName = isStation ? appData.stations.find(s => s.id === node?.stationId)?.name : '中継点';
                                
                                return (
                                  <div key={idx} className="mb-4 relative group">
                                    <div className="absolute -left-[2.35rem] top-2 w-4 h-4 rounded-full border-4 border-white bg-blue-500 shadow-sm" />
                                    <div className="bg-white border border-gray-200 rounded-md p-2 shadow-sm">
                                       <div className="flex items-center justify-between text-[11px] font-black mb-1">
                                          <span>{stationName}</span>
                                          <div className="flex items-center gap-1">
                                            <button 
                                              className={`px-1 rounded ${step.action === 'stop' ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-500'}`}
                                              onClick={() => {
                                                setAppData(prev => ({
                                                  ...prev,
                                                  trains: prev.trains.map(t => t.id === train.id ? {
                                                    ...t,
                                                    route: t.route.map((s, i) => i === idx ? { ...s, action: s.action === 'stop' ? 'pass' : 'stop' } : s)
                                                  } : t)
                                                }));
                                              }}
                                            >
                                              ({step.action === 'stop' ? '停車' : '通過'})
                                            </button>
                                            <button 
                                              className="text-gray-300 hover:text-red-500"
                                              onClick={() => {
                                                setAppData(prev => ({
                                                  ...prev,
                                                  trains: prev.trains.map(t => t.id === train.id ? {
                                                    ...t,
                                                    route: t.route.filter((_, i) => i !== idx)
                                                  } : t)
                                                }));
                                              }}
                                            >
                                              <Trash2 size={10} />
                                            </button>
                                          </div>
                                       </div>
                                       <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[10px] text-gray-500">
                                          <div className="flex items-center gap-1">
                                            <span>着:</span>
                                            <input 
                                              type="text" className="w-10 text-blue-600 underline" 
                                              value={formatTime(step.arrivalTime).slice(3)} 
                                              onChange={(e) => {
                                                const [m, s] = e.target.value.split(':').map(Number);
                                                const newSec = (m || 0) * 60 + (s || 0);
                                                setAppData(prev => ({
                                                  ...prev,
                                                  trains: prev.trains.map(t => t.id === train.id ? {
                                                    ...t,
                                                    route: t.route.map((s, i) => i === idx ? { ...s, arrivalTime: newSec } : s)
                                                  } : t)
                                                }));
                                              }}
                                            />
                                          </div>
                                          <div className="flex items-center gap-1">
                                            <span>発:</span>
                                            <input 
                                              type="text" className="w-10 text-blue-600 underline" 
                                              value={formatTime(step.departureTime).slice(3)}
                                              onChange={(e) => {
                                                const [m, s] = e.target.value.split(':').map(Number);
                                                const newSec = (m || 0) * 60 + (s || 0);
                                                setAppData(prev => ({
                                                  ...prev,
                                                  trains: prev.trains.map(t => t.id === train.id ? {
                                                    ...t,
                                                    route: t.route.map((s, i) => i === idx ? { ...s, departureTime: newSec } : s)
                                                  } : t)
                                                }));
                                              }}
                                            />
                                          </div>
                                       </div>
                                    </div>
                                    {idx < train.route.length - 1 && (
                                       <div className="py-2 text-[10px] text-gray-400 font-bold flex items-center gap-2">
                                          <div className="h-px flex-1 bg-gray-100" />
                                          所要: {Math.floor((train.route[idx+1].arrivalTime - step.departureTime) / 60)}分
                                          <div className="h-px flex-1 bg-gray-100" />
                                       </div>
                                    )}
                                  </div>
                                );
                              })}
                           </div>

                           <button 
                             onClick={() => {
                                if (selectedEntity?.type !== 'node') return;
                                
                                setAppData(prev => {
                                  const train = prev.trains.find(t => t.id === selectedEntity.id) || prev.trains[0]; 
                                  const trainId = selectedEntity.type === 'train' ? selectedEntity.id : (prev.trains.find(t => t.id === selectedEntity.id)?.id || prev.trains[0]?.id);
                                  
                                  // Find currently active train if any
                                  const targetTrain = prev.trains.find(t => t.id === trainId);
                                  if (!targetTrain) return prev;

                                  const lastStep = targetTrain.route[targetTrain.route.length - 1];
                                  const newStep: RouteStep = {
                                    nodeId: selectedEntity.id,
                                    action: 'stop',
                                    arrivalTime: 0,
                                    departureTime: 0
                                  };
                                  
                                  const newRoute = autoCalculateTimes(targetTrain.id, [...targetTrain.route, newStep]);
                                  
                                  return {
                                    ...prev,
                                    trains: prev.trains.map(t => t.id === targetTrain.id ? { ...t, route: newRoute } : t)
                                  };
                                });
                             }}
                             className={`mt-2 w-full py-1.5 text-xs font-bold rounded border ${selectedEntity?.type === 'node' ? 'border-blue-200 text-blue-600 bg-blue-50' : 'border-gray-200 text-gray-300 bg-gray-50'}`}
                           >
                             選択中の点を経路に追加
                           </button>

                           {/* Reverse / Round trip logic controls */}
                           <div className="mt-4 pt-4 border-t border-gray-100 space-y-2">
                              <div className="flex items-center justify-between text-[11px] font-bold">
                                 <span className="text-gray-500">繰り返し待機</span>
                                 <div className="flex items-center gap-2">
                                    <input 
                                      type="number" className="w-10 bg-gray-50 border-none p-1 rounded" 
                                      value={train.interval / 60} 
                                      onChange={(e) => {
                                        const val = Number(e.target.value) * 60;
                                        setAppData(prev => ({
                                          ...prev,
                                          trains: prev.trains.map(t => t.id === train.id ? { ...t, interval: val } : t)
                                        }));
                                      }}
                                    />
                                    <span>分</span>
                                 </div>
                              </div>
                              <button 
                                onClick={() => {
                                  // Auto-generate reverse route
                                  const rev = [...train.route].reverse().map((s, i) => {
                                    const offset = train.route[train.route.length - 1].arrivalTime + 300;
                                    return {
                                      ...s,
                                      arrivalTime: offset + i * 300,
                                      departureTime: offset + i * 300 + 60
                                    }
                                  });
                                  setAppData(p => ({ ...p, trains: p.trains.map(t => t.id === train.id ? { ...t, reverseRoute: rev } : t) }));
                                }}
                                className="w-full py-1 text-[10px] font-black uppercase text-gray-400 border border-gray-200 rounded hover:bg-gray-50"
                              >
                                <ArrowRightLeft size={10} className="inline mr-1" /> 復路を自動生成
                              </button>
                           </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {activeTab === 'run' && (
                  <div className="space-y-4">
                    <div className="p-4 bg-blue-50 border border-blue-100 rounded-lg">
                      <div className="flex items-center justify-between mb-4">
                        <span className="text-xs font-black text-blue-900">運行サマリー</span>
                        <span className="text-xs px-2 py-0.5 bg-blue-600 text-white rounded-full">稼働中</span>
                      </div>
                      <div className="space-y-2">
                        <div className="flex justify-between text-xs">
                          <span className="text-blue-700">総列車数</span>
                          <span className="font-mono font-bold">{appData.trains.length} 本</span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-blue-700">総駅数</span>
                          <span className="font-mono font-bold">{appData.stations.length} 箇所</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Data Tools */}
              <div className="p-4 border-t border-[#dee2e6] bg-[#f8f9fa] grid grid-cols-2 gap-2">
                 <button 
                    onClick={() => {
                        const blob = new Blob([JSON.stringify(appData)], { type: 'application/json' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `railway_sim_${Date.now()}.json`;
                        a.click();
                    }}
                    className="flex items-center justify-center gap-2 py-1.5 text-[10px] font-bold border border-gray-200 bg-white rounded hover:bg-gray-50"
                 >
                    <Download size={12} /> エクスポート
                 </button>
                 <button 
                    onClick={() => {
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.onchange = (e: any) => {
                            const file = e.target.files[0];
                            const reader = new FileReader();
                            reader.onload = (re) => {
                                try {
                                    const data = JSON.parse(re.target?.result as string);
                                    setAppData(data);
                                } catch (err) {
                                    alert('Invalid dataset');
                                }
                            };
                            reader.readAsText(file);
                        };
                        input.click();
                    }}
                    className="flex items-center justify-center gap-2 py-1.5 text-[10px] font-bold border border-gray-200 bg-white rounded hover:bg-gray-50"
                 >
                    <Upload size={12} /> インポート
                 </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Simple handle to re-open panel on desktop */}
        {!isPanelOpen && (
          <button 
            onClick={() => setIsPanelOpen(true)}
            className="absolute right-0 top-1/2 -translate-y-12 bg-white border border-r-0 border-gray-200 p-2 rounded-l-md shadow-md hidden md:block"
          >
            <Settings size={18} className="text-gray-400" />
          </button>
        )}
      </main>

      {/* Tabs */}
      <nav className="h-20 bg-white border-top border-[#dee2e6] grid grid-cols-4 z-40">
        {[
          { id: 'station' as const, icon: MapIcon, label: '駅配置' },
          { id: 'track' as const, icon: GitBranch, label: '配線' },
          { id: 'dia' as const, icon: Clock, label: 'ダイヤ' },
          { id: 'run' as const, icon: Play, label: '実行' },
        ].map(tab => (
          <button 
            key={tab.id}
            onClick={() => {
              setActiveTab(tab.id);
              setIsPanelOpen(true);
            }}
            className={`flex flex-col items-center justify-center gap-1.5 transition-colors relative ${activeTab === tab.id ? 'text-[#0056b3]' : 'text-[#6c757d]'}`}
          >
            <tab.icon size={22} fill={activeTab === tab.id ? 'rgba(0,86,179,0.1)' : 'transparent'} />
            <span className="text-[11px] font-black tracking-tighter uppercase">{tab.label}</span>
            {activeTab === tab.id && (
              <motion.div 
                layoutId="activeTab"
                className="absolute top-0 w-8 h-1 bg-[#0056b3] rounded-b-full"
              />
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}
