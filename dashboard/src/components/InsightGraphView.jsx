import { useState, useEffect, useRef, useMemo } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import { fetchInsightsForGraph, fetchInsightSources } from '../lib/supabase.js'
import { buildGraph } from '../lib/graph.js'

const DOMAINS = [
  { id: 'ai', label: 'AI', categoryName: 'AI' },
  { id: 'it', label: 'IT', categoryName: 'IT' },
  { id: 'entrepreneurship', label: 'Entrepreneurship', categoryName: 'Entrepreneurship' },
  { id: 'business', label: 'Business', categoryName: 'Business' },
  { id: 'ux', label: 'UX Design', categoryName: 'UX Design' },
]

export default function InsightGraphView({ categories = [] }) {
  const [domainId, setDomainId] = useState('all')
  const [includeCandidates, setIncludeCandidates] = useState(false)
  const [raw, setRaw] = useState({ insights: [], sources: [] })
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null) // { node, sources, loadingSources }

  const containerRef = useRef(null)
  const [dims, setDims] = useState({ width: 800, height: 600 })

  useEffect(() => {
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeCandidates])

  useEffect(() => {
    setSelected(null)
  }, [domainId])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setDims({ width: el.clientWidth, height: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  async function fetchData() {
    setIsLoading(true)
    setError(null)
    setSelected(null)
    try {
      setRaw(await fetchInsightsForGraph(includeCandidates))
    } catch (e) {
      setError(e.message)
      setRaw({ insights: [], sources: [] })
    } finally {
      setIsLoading(false)
    }
  }

  function colorForDomain(id) {
    const domain = DOMAINS.find((d) => d.id === id)
    const category = categories.find((c) => c.name === domain?.categoryName)
    return category?.color || '#9CA3AF'
  }

  const graph = useMemo(() => {
    const insights = domainId === 'all'
      ? raw.insights
      : raw.insights.filter((i) => (i.domains || []).includes(domainId))
    return buildGraph(insights, raw.sources)
  }, [raw, domainId])

  const neighbors = useMemo(() => {
    if (!selected) return null
    const set = new Set([selected.node.id])
    for (const l of graph.links) {
      const s = l.source.id || l.source
      const t = l.target.id || l.target
      if (s === selected.node.id) set.add(t)
      if (t === selected.node.id) set.add(s)
    }
    return set
  }, [selected, graph.links])

  async function handleNodeClick(node) {
    setSelected({ node, sources: null, loadingSources: true })
    try {
      const sources = await fetchInsightSources(node.id)
      setSelected((cur) => (cur && cur.node.id === node.id ? { ...cur, sources, loadingSources: false } : cur))
    } catch {
      setSelected((cur) => (cur && cur.node.id === node.id ? { ...cur, sources: [], loadingSources: false } : cur))
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Controls */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 flex-wrap">
        <div className="flex gap-1">
          <FilterButton active={domainId === 'all'} onClick={() => setDomainId('all')}>All</FilterButton>
          {DOMAINS.map((d) => (
            <FilterButton key={d.id} active={domainId === d.id} onClick={() => setDomainId(d.id)}>
              <span className="w-2 h-2 rounded-full inline-block mr-1.5 align-middle" style={{ backgroundColor: colorForDomain(d.id) }} />
              {d.label}
            </FilterButton>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-500 cursor-pointer ml-auto">
          <input type="checkbox" checked={includeCandidates} onChange={(e) => setIncludeCandidates(e.target.checked)}
            className="rounded border-gray-300 text-gray-900 focus:ring-gray-400" />
          Include candidates
        </label>
      </div>

      {/* Graph + side panel */}
      <div className="flex-1 flex min-h-0">
        <div ref={containerRef} className="flex-1 relative min-h-0">
          {isLoading ? (
            <Centered><span className="text-sm text-gray-400">Loading graph…</span></Centered>
          ) : error ? (
            <Centered>
              <div className="text-center">
                <p className="text-sm text-red-500 font-medium">Couldn't load the graph</p>
                <p className="text-xs text-gray-400 mt-1 mb-3">{error}</p>
                <button onClick={fetchData} className="text-xs text-gray-600 border border-gray-200 rounded-md px-3 py-1.5 hover:bg-gray-50">Try again</button>
              </div>
            </Centered>
          ) : graph.nodes.length === 0 ? (
            <Centered><span className="text-sm text-gray-400">No insights to graph yet.</span></Centered>
          ) : (
            <ForceGraph2D
              graphData={graph}
              width={dims.width}
              height={dims.height}
              nodeId="id"
              nodeVal={(n) => Math.max(1, n.sourceCount)}
              nodeLabel={(n) => n.text}
              nodeColor={(n) => {
                if (neighbors && !neighbors.has(n.id)) return 'rgba(180,180,180,0.15)'
                return colorForDomain((n.domains || [])[0])
              }}
              linkWidth={(l) => Math.max(1, l.weight)}
              linkColor={(l) => {
                if (!neighbors) return 'rgba(150,150,150,0.25)'
                const s = l.source.id || l.source
                const t = l.target.id || l.target
                return neighbors.has(s) && neighbors.has(t) ? 'rgba(120,120,120,0.6)' : 'rgba(200,200,200,0.08)'
              }}
              onNodeClick={handleNodeClick}
              onBackgroundClick={() => setSelected(null)}
              cooldownTicks={100}
            />
          )}
        </div>

        {selected && (
          <SidePanel
            node={selected.node}
            sources={selected.sources}
            loading={selected.loadingSources}
            domainLabels={(selected.node.domains || []).map((d) => DOMAINS.find((x) => x.id === d)?.label || d)}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  )
}

function FilterButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1.5 rounded-md text-sm transition-colors whitespace-nowrap ${
        active ? 'bg-gray-100 text-gray-900 font-medium' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
      }`}
    >
      {children}
    </button>
  )
}

function Centered({ children }) {
  return <div className="absolute inset-0 flex items-center justify-center">{children}</div>
}

function SidePanel({ node, sources, loading, domainLabels, onClose }) {
  return (
    <div className="w-80 shrink-0 border-l border-gray-100 overflow-y-auto p-5">
      <div className="flex items-start justify-between gap-2 mb-3">
        <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-gray-50 text-gray-500 border-gray-100 capitalize">{node.status}</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <p className="text-sm text-gray-900 leading-relaxed">{node.text}</p>
      <p className="text-xs text-gray-400 mt-2">
        {domainLabels.join(' · ')}
        {typeof node.confidence === 'number' ? ` · confidence ${node.confidence.toFixed(2)}` : ''}
      </p>
      <div className="mt-4 pt-4 border-t border-gray-50">
        <p className="text-xs font-medium text-gray-500 mb-2">Sources ({node.sourceCount})</p>
        {loading ? (
          <p className="text-xs text-gray-300">Loading sources…</p>
        ) : (
          <ul className="space-y-1.5">
            {(sources || []).map(({ article }) => article && (
              <li key={article.id} className="text-xs text-gray-500">
                {article.url ? (
                  <a href={article.url} target="_blank" rel="noreferrer" className="hover:text-gray-700 hover:underline">→ {article.title}</a>
                ) : (
                  <span>→ {article.title}</span>
                )}
                {article.source?.name && <span className="text-gray-300"> — {article.source.name}</span>}
              </li>
            ))}
            {(sources || []).filter((s) => s.article).length === 0 && <li className="text-xs text-gray-300">No sources.</li>}
          </ul>
        )}
      </div>
    </div>
  )
}
