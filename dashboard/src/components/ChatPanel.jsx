import { useState, useRef, useEffect } from 'react'
import { SUGGESTED_QUESTIONS } from '../lib/mockData.js'

// Mock Claude responses for demo mode
function generateMockResponse(question, article) {
  const responses = [
    `That's a sharp question about "${article.title.slice(0, 40)}...". The short answer is that the implications run deeper than the headline suggests. The key tension here is between short-term competitive advantage and longer-term structural change — most incumbents are optimizing for the former while the latter is what will actually matter in 18–24 months. Worth keeping an eye on how the smaller players in this space respond, as they often signal where the market is heading before the majors acknowledge it.`,
    `Good angle. The counterargument worth taking seriously is that the scale of this shift is being overstated in the near term, even if the direction is right. Adoption curves for enterprise technology rarely follow the analyst projections — there are procurement cycles, integration costs, and organizational inertia that slow things down considerably. That said, the fundamentals here are strong, and the companies that move early will have a meaningful moat by the time the majority catches up.`,
    `The 30–90 day horizon here is interesting. The most likely development to watch for is a response from the two or three adjacent players who haven't publicly commented yet — their silence is usually strategic. There's also a regulatory angle developing quietly that could change the calculus significantly if it moves faster than the market expects. I'd flag this as a "slow burn" story that's worth revisiting in a month.`,
    `The business model angle is actually the most underrated part of this story. The surface-level read is about the product or technology, but the real story is about how this changes the unit economics for everyone downstream in the value chain. The companies that understand this second-order effect first are the ones who'll capture disproportionate value. It maps closely to what we saw in cloud infrastructure 2012–2015 — the platform shift was obvious, but the winners weren't the ones making the most noise.`,
  ]
  return responses[Math.floor(Math.random() * responses.length)]
}

export default function ChatPanel({ article }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading])

  async function sendMessage(text) {
    if (!text.trim() || isLoading) return

    const userMsg = { role: 'user', content: text }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setIsLoading(true)

    // Simulate Claude API latency
    await new Promise(r => setTimeout(r, 1400 + Math.random() * 800))

    const assistantMsg = {
      role: 'assistant',
      content: generateMockResponse(text, article),
    }
    setMessages(prev => [...prev, assistantMsg])
    setIsLoading(false)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  const showSuggestions = messages.length === 0

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-5 py-3.5 border-b border-gray-100 flex items-center gap-2">
        <div className="w-5 h-5 rounded bg-gradient-to-br from-pink-500 to-violet-600 flex items-center justify-center">
          <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
        </div>
        <span className="text-sm font-medium text-gray-700">Ask about this article</span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {showSuggestions && (
          <div>
            <p className="text-xs text-gray-400 mb-3">Try asking:</p>
            <div className="space-y-2">
              {SUGGESTED_QUESTIONS.map((q, i) => (
                <button
                  key={i}
                  onClick={() => sendMessage(q)}
                  className="w-full text-left text-xs text-gray-600 bg-gray-50 hover:bg-gray-100 border border-gray-100 hover:border-gray-200 rounded-lg px-3 py-2.5 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
              msg.role === 'user'
                ? 'bg-gray-900 text-white rounded-br-sm'
                : 'bg-gray-100 text-gray-800 rounded-bl-sm'
            }`}>
              {msg.content}
            </div>
          </div>
        ))}

        {/* Typing indicator */}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-gray-400 rounded-full typing-dot" />
              <span className="w-1.5 h-1.5 bg-gray-400 rounded-full typing-dot" />
              <span className="w-1.5 h-1.5 bg-gray-400 rounded-full typing-dot" />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-3 border-t border-gray-100">
        <div className="flex items-end gap-2 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 focus-within:border-gray-400 focus-within:bg-white transition-colors">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a follow-up question…"
            rows={1}
            className="flex-1 resize-none bg-transparent text-sm text-gray-800 placeholder-gray-400 outline-none leading-relaxed"
            style={{ maxHeight: '120px' }}
          />
          <button
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || isLoading}
            className="shrink-0 w-7 h-7 rounded-lg bg-gray-900 text-white flex items-center justify-center hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
            </svg>
          </button>
        </div>
        <p className="text-xs text-gray-400 mt-1.5 px-1">Press Enter to send · Shift+Enter for new line</p>
      </div>
    </div>
  )
}
