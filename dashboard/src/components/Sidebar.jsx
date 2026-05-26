import { format } from 'date-fns'
import { useNavigate, useLocation, Link } from 'react-router-dom'

const today = format(new Date(), 'EEEE, MMMM d')

export default function Sidebar({ categories = [], savedCount, onClose }) {
  const navigate = useNavigate()
  const location = useLocation()

  // Derive active nav key from current URL
  const parts = location.pathname.split('/').filter(Boolean)
  const activeNav = parts[0] === 'category' ? parts[1]
    : parts[0] || 'briefing'

  function handleNav(key) {
    if (key === 'briefing') navigate('/briefing')
    else if (key === 'saved') navigate('/saved')
    else if (key === 'trends') navigate('/trends')
    else navigate(`/category/${key}`)
  }

  return (
    <aside className="w-60 bg-gray-900 text-gray-300 flex flex-col shrink-0 h-full">
      {/* Logo */}
      <div className="px-5 pt-6 pb-5 border-b border-gray-800">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-pink-500 to-violet-600 flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          </div>
          <div className="flex-1">
            <div className="text-white font-semibold text-sm leading-tight">EJ Newsfeed</div>
            <div className="text-gray-500 text-xs">{today}</div>
          </div>
          {onClose && (
            <button onClick={onClose} className="md:hidden p-1 rounded-md text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">

        <NavItem
          label="Morning Briefing"
          isActive={activeNav === 'briefing'}
          onClick={() => handleNav('briefing')}
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
          }
        />

        <div className="pt-4 pb-1 px-2">
          <span className="text-xs font-medium text-gray-600 uppercase tracking-wider">Categories</span>
        </div>

        {categories.map(cat => (
          <NavItem
            key={cat.id}
            label={cat.name}
            isActive={activeNav === cat.id}
            onClick={() => handleNav(cat.id)}
            dot={cat.color}
          />
        ))}

        <div className="pt-4 pb-0.5">
          <div className="h-px bg-gray-800" />
        </div>

        <NavItem
          label="Trends"
          isActive={activeNav === 'trends'}
          onClick={() => handleNav('trends')}
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941" />
            </svg>
          }
        />

        <NavItem
          label="Saved"
          isActive={activeNav === 'saved'}
          onClick={() => handleNav('saved')}
          badge={savedCount > 0 ? savedCount : null}
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
          }
        />
      </nav>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-gray-800 space-y-3">
        <div className="flex items-center gap-2 text-xs text-gray-600">
          <div className="w-5 h-5 rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center text-white font-semibold text-xs">E</div>
          <span>ej.newsfeed@gmail.com</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-600">
          <Link to="/privacy" className="hover:text-gray-400 transition-colors">Privacy Policy</Link>
          <span className="text-gray-700">·</span>
          <Link to="/terms" className="hover:text-gray-400 transition-colors">Terms</Link>
        </div>
      </div>
    </aside>
  )
}

function NavItem({ label, isActive, onClick, icon, dot, badge }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm transition-colors text-left ${
        isActive
          ? 'bg-gray-800 text-white'
          : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
      }`}
    >
      {dot && <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: dot }} />}
      {icon && <span className="shrink-0">{icon}</span>}
      <span className="flex-1 truncate">{label}</span>
      {badge && (
        <span className="bg-gray-700 text-gray-300 text-xs rounded-full px-1.5 py-0.5 leading-none">{badge}</span>
      )}
    </button>
  )
}
