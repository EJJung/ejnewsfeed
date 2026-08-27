import { format } from 'date-fns'
import { useNavigate, useLocation, Link } from 'react-router-dom'

const today = format(new Date(), 'EEEE, MMMM d')

export default function Sidebar({ categories = [], savedCount, onClose, isAdmin = false, onSignOut }) {
  const navigate = useNavigate()
  const location = useLocation()

  // Derive active nav key from current URL
  const parts = location.pathname.split('/').filter(Boolean)
  const activeNav = parts[0] === 'category' ? parts[1]
    : parts[0] || 'briefing'

  function handleNav(key) {
    if (key === 'briefing') navigate('/briefing')
    else if (key === 'recommended') navigate('/recommended')
    else if (key === 'podcast') navigate('/podcast')
    else if (key === 'saved') navigate('/saved')
    else if (key === 'trends') navigate('/trends')
    else if (key === 'knowledge') navigate('/knowledge')
    else if (key === 'graph') navigate('/graph')
    else if (key === 'meetings') navigate('/meetings')
    else if (key === 'admin') navigate('/admin')
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

        <NavItem
          label="Recommended"
          isActive={activeNav === 'recommended'}
          onClick={() => handleNav('recommended')}
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.196-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
            </svg>
          }
        />

        <NavItem
          label="Podcast"
          isActive={activeNav === 'podcast'}
          onClick={() => handleNav('podcast')}
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0m7 7v3m-4 0h8m-4-6a3 3 0 01-3-3V5a3 3 0 116 0v4a3 3 0 01-3 3z" />
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
          label="Knowledge"
          isActive={activeNav === 'knowledge'}
          onClick={() => handleNav('knowledge')}
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
            </svg>
          }
        />

        <NavItem
          label="Insight Graph"
          isActive={activeNav === 'graph'}
          onClick={() => handleNav('graph')}
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6a2 2 0 100-4 2 2 0 000 4zM6 20a2 2 0 100-4 2 2 0 000 4zM18 20a2 2 0 100-4 2 2 0 000 4zM12 6l-6 10M12 6l6 10M8 18h8" />
            </svg>
          }
        />

        <NavItem
          label="Meetings"
          isActive={activeNav === 'meetings'}
          onClick={() => handleNav('meetings')}
          icon={
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4z" />
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

        {isAdmin && (
          <>
            <div className="pt-4 pb-0.5">
              <div className="h-px bg-gray-800" />
            </div>
            <NavItem
              label="Pipeline Admin"
              isActive={activeNav === 'admin'}
              onClick={() => handleNav('admin')}
              icon={
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.636 18.364a9 9 0 010-12.728m12.728 0a9 9 0 010 12.728M9 10a3 3 0 106 0 3 3 0 00-6 0z" />
                </svg>
              }
            />
          </>
        )}
      </nav>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-gray-800 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-gray-600">
            <div className="w-5 h-5 rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center text-white font-semibold text-xs">E</div>
            <span>ej.newsfeed@gmail.com</span>
          </div>
          {onSignOut && (
            <button
              onClick={onSignOut}
              className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
              title="Sign out"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          )}
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
