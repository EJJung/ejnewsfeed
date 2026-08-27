import { useState, useEffect } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { listEpisodes } from '../lib/supabase.js'
import { splitByKind, formatDuration, transcriptText } from '../lib/episodes.js'

export default function PodcastView() {
  const [episodes, setEpisodes] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError]         = useState(null)
  const [playingId, setPlayingId] = useState(null)

  useEffect(() => {
    fetchEpisodes()
  }, [])

  async function fetchEpisodes() {
    setIsLoading(true)
    setError(null)
    try {
      const data = await listEpisodes()
      setEpisodes(data)
    } catch (e) {
      setError(e.message)
      setEpisodes([])
    } finally {
      setIsLoading(false)
    }
  }

  const { weekly, daily } = splitByKind(episodes)

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 py-5 md:px-8 md:py-8">

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-gray-900">Podcast</h1>
          <p className="text-sm text-gray-400">
            Your daily briefs and weekly deep dives — listen right here
          </p>
        </div>

        {/* Content */}
        {isLoading ? (
          <LoadingSkeleton />
        ) : error ? (
          <ErrorState message={error} onRetry={fetchEpisodes} />
        ) : episodes.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-8">
            {weekly.length > 0 && (
              <Section title="Weekly Deep Dive">
                {weekly.map(ep => (
                  <EpisodeCard
                    key={ep.id}
                    episode={ep}
                    isPlaying={playingId === ep.id}
                    onPlay={() => setPlayingId(ep.id)}
                  />
                ))}
              </Section>
            )}
            {daily.length > 0 && (
              <Section title="Daily Briefs">
                {daily.map(ep => (
                  <EpisodeCard
                    key={ep.id}
                    episode={ep}
                    isPlaying={playingId === ep.id}
                    onPlay={() => setPlayingId(ep.id)}
                  />
                ))}
              </Section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div>
      <h2 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">{title}</h2>
      <div className="space-y-4">{children}</div>
    </div>
  )
}

function EpisodeCard({ episode, isPlaying, onPlay }) {
  const [showTranscript, setShowTranscript] = useState(false)
  const timeAgo = episode.published_at
    ? formatDistanceToNow(new Date(episode.published_at), { addSuffix: true })
    : null
  const kindLabel = episode.kind === 'weekly' ? 'Weekly' : 'Daily'

  return (
    <div className="border border-gray-100 rounded-xl p-5 hover:border-gray-200 transition-colors">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-gray-50 text-gray-500 border-gray-100">
          {kindLabel}
        </span>
        {timeAgo && <span className="text-xs text-gray-400">{timeAgo}</span>}
      </div>

      <h3 className="text-sm font-medium text-gray-900 leading-relaxed">{episode.title}</h3>
      <p className="text-xs text-gray-400 mt-1">{formatDuration(episode.duration_seconds)}</p>

      {/* Player */}
      <div className="mt-4">
        {isPlaying ? (
          <audio controls autoPlay src={episode.audio_url} className="w-full h-10">
            Your browser does not support the audio element.
          </audio>
        ) : episode.audio_url ? (
          <button
            onClick={onPlay}
            className="flex items-center gap-2 text-sm text-gray-700 border border-gray-200 rounded-md px-3 py-1.5 hover:bg-gray-50 transition-colors"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
            Play
          </button>
        ) : (
          <span className="flex items-center gap-2 text-sm text-gray-400 border border-gray-100 rounded-md px-3 py-1.5">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
            Audio unavailable
          </span>
        )}
      </div>

      {/* Transcript */}
      <div className="mt-3 pt-3 border-t border-gray-50">
        <button
          onClick={() => setShowTranscript(v => !v)}
          className="text-xs text-gray-400 hover:text-gray-600 transition-colors flex items-center gap-1"
        >
          <span className={`inline-block transition-transform ${showTranscript ? 'rotate-90' : ''}`}>▸</span>
          {showTranscript ? 'Hide transcript' : 'Show transcript'}
        </button>
        {showTranscript && (
          <p className="text-xs text-gray-500 mt-2 whitespace-pre-wrap leading-relaxed">
            {transcriptText(episode)}
          </p>
        )}
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="text-center py-16">
      <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
        <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0m7 7v3m-4 0h8m-4-6a3 3 0 01-3-3V5a3 3 0 116 0v4a3 3 0 01-3 3z" />
        </svg>
      </div>
      <p className="text-sm text-gray-500 font-medium">No episodes yet</p>
      <p className="text-xs text-gray-400 mt-1">
        The daily brief and weekly deep dive appear here once they're generated.
      </p>
    </div>
  )
}

function ErrorState({ message, onRetry }) {
  return (
    <div className="text-center py-16">
      <p className="text-sm text-red-500 font-medium">Couldn't load episodes</p>
      <p className="text-xs text-gray-400 mt-1 mb-4">{message}</p>
      <button
        onClick={onRetry}
        className="text-xs text-gray-600 border border-gray-200 rounded-md px-3 py-1.5 hover:bg-gray-50 transition-colors"
      >
        Try again
      </button>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      {[1, 2, 3].map(i => (
        <div key={i} className="border border-gray-100 rounded-xl p-5">
          <div className="flex justify-between mb-3">
            <div className="h-5 bg-gray-100 rounded w-16" />
            <div className="h-5 bg-gray-100 rounded w-20" />
          </div>
          <div className="space-y-2">
            <div className="h-4 bg-gray-100 rounded w-3/4" />
            <div className="h-8 bg-gray-100 rounded w-24 mt-3" />
          </div>
        </div>
      ))}
    </div>
  )
}
