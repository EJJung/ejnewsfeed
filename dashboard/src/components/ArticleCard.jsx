import { formatDistanceToNow } from 'date-fns'

export default function ArticleCard({ article, category, isSaved, onArticleClick, onToggleSave }) {
  const timeAgo = article.published_at
    ? formatDistanceToNow(new Date(article.published_at), { addSuffix: true })
    : null

  return (
    <div className="group bg-white border border-gray-100 rounded-xl px-4 py-3.5 hover:border-gray-200 hover:shadow-sm transition-all cursor-pointer">
      <div className="flex items-start gap-3">
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

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
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
