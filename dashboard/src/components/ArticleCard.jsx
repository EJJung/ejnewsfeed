import { formatDistanceToNow } from 'date-fns'

export default function ArticleCard({ article, category, isSaved, onArticleClick, onToggleSave }) {
  const timeAgo = article.published_at
    ? formatDistanceToNow(new Date(article.published_at), { addSuffix: true })
    : null
  const isVideo = article.content_type === 'youtube'
  const durationLabel = article.duration_seconds
    ? `${Math.floor(article.duration_seconds / 60)}m`
    : null

  return (
    <div className="group bg-white border border-gray-100 rounded-xl px-4 py-3.5 hover:border-gray-200 hover:shadow-sm transition-all cursor-pointer">
      <div className="flex items-start gap-3">
        {isVideo && article.thumbnail_url && (
          <img
            src={article.thumbnail_url}
            alt=""
            className="w-16 h-16 rounded-lg object-cover shrink-0"
            onClick={() => onArticleClick(article)}
          />
        )}
        <div className="flex-1 min-w-0" onClick={() => onArticleClick(article)}>
          <h3 className="text-sm font-medium text-gray-900 leading-snug group-hover:text-gray-700 transition-colors">
            {article.title}
          </h3>
          <p className="text-xs text-gray-500 mt-1 line-clamp-2 leading-relaxed">
            {article.snippet}
          </p>
          <div className="flex items-center gap-2 mt-2">
            {article.source && (
              <span className="text-xs text-gray-400">{article.source}</span>
            )}
            {isVideo && (
              <>
                <span className="text-gray-300 text-xs">·</span>
                <span className="text-xs text-gray-400 flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                  {durationLabel}
                </span>
              </>
            )}
            {timeAgo && (
              <>
                <span className="text-gray-300 text-xs">·</span>
                <span className="text-xs text-gray-400">{timeAgo}</span>
              </>
            )}
            {/* Secondary category tags */}
            {article.category_tags && article.category_tags.length > 1 && (
              <>
                <span className="text-gray-300 text-xs">·</span>
                {article.category_tags
                  .filter(t => t !== category?.name)
                  .slice(0, 2)
                  .map(tag => (
                    <span key={tag} className="text-xs text-gray-400 bg-gray-50 border border-gray-100 px-1.5 py-0.5 rounded">
                      {tag}
                    </span>
                  ))}
              </>
            )}
          </div>
        </div>

        {/* Actions — always visible on mobile, hover-reveal on desktop */}
        <div className="flex items-center gap-1 shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
          {/* Save toggle */}
          <button
            onClick={(e) => { e.stopPropagation(); onToggleSave(article.id) }}
            className={`p-1.5 rounded-md transition-colors ${
              isSaved
                ? 'text-gray-900 bg-gray-100'
                : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50'
            }`}
            title={isSaved ? 'Unsave' : 'Save'}
          >
            <svg className="w-3.5 h-3.5" fill={isSaved ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
          </button>

          {/* Dive button */}
          <button
            onClick={() => onArticleClick(article)}
            className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
            title="Get in-depth insight"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
