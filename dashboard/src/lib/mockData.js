// ============================================================
// Mock data — used until Supabase + pipeline are wired up.
// Shows the full dashboard experience on day one.
// ============================================================

export const CATEGORIES = [
  { id: '1', name: 'AI',               color: '#EC4899', description: 'Artificial intelligence, machine learning, and LLMs' },
  { id: '2', name: 'IT',               color: '#3B82F6', description: 'Software, infrastructure, hardware, and developer tools' },
  { id: '3', name: 'Entrepreneurship', color: '#10B981', description: 'Startups, venture capital, and founder stories' },
  { id: '4', name: 'UX Design',        color: '#8B5CF6', description: 'Design systems, user experience, and product thinking' },
  { id: '5', name: 'Business',         color: '#F59E0B', description: 'Strategy, markets, corporate news, and macro trends' },
]

export const TODAY_SUMMARIES = [
  {
    category_id: '1',
    summary: "The AI landscape today is defined by two competing pressures: rapid capability improvements from frontier labs and the beginning of serious regulatory enforcement. Claude 3.7's reasoning gains and DeepMind's AlphaFold 3 paper show the research pace hasn't slowed, while the EU AI Act's enforcement phase marks a turning point for enterprise deployments. The gap between what AI can do and what companies are legally allowed to do with it is about to become a central business problem.",
    article_count: 3,
  },
  {
    category_id: '2',
    summary: "Infrastructure is the dominant theme in today's IT news. Apple's M4 Ultra benchmarks reveal a step-change in on-device AI processing that will reshape what's feasible in edge computing. Meanwhile, Google Cloud's new serverless database tier intensifies the race with AWS and Azure for enterprise workloads. The Linux 6.8 kernel update signals the open source community is increasingly optimizing for the AI-era workload profile.",
    article_count: 3,
  },
  {
    category_id: '3',
    summary: "Early 2026 is shaping up as a reset moment for venture capital. Y Combinator's W26 batch is overwhelmingly AI-native, reflecting where founder and investor conviction has converged. Sequoia's new climate tech fund signals big capital is hedging into the next regulatory wave. Notion's growth story stands out as a masterclass in product-led growth — and a useful counterweight to the paid acquisition playbooks that dominated the last cycle.",
    article_count: 3,
  },
  {
    category_id: '4',
    summary: "Design tooling and platform guidelines are evolving faster than most teams can absorb. Figma's AI-assisted component suggestions mark the beginning of a shift from 'design tool' to 'design co-pilot.' Apple's Vision Pro HIG updates are forcing a rethink of fundamental interaction models. And the EU's new dark patterns regulation is about to make conversion-focused design a legal liability rather than just an ethical concern.",
    article_count: 3,
  },
  {
    category_id: '5',
    summary: "Big Tech earnings continue to reinforce the AI infrastructure thesis, with AWS posting 28% YoY revenue growth. OpenAI's $157B valuation is the clearest signal yet of how much capital is chasing AI infrastructure bets. The remote work productivity study adds a data-backed dimension to debates that have mostly been ideological — useful ammunition for companies still designing their hybrid policies.",
    article_count: 3,
  },
]

export const ARTICLES = [
  // AI
  {
    id: 'a1',
    title: "Claude 3.7 Sets New Benchmark on Complex Reasoning Tasks",
    url: "https://anthropic.com/news",
    snippet: "Anthropic's latest model shows a 34% improvement on multi-step reasoning benchmarks, outperforming GPT-4o and Gemini Ultra on the MATH and GPQA datasets. The gains come primarily from improved chain-of-thought consistency rather than raw scale.",
    source: "MIT Technology Review",
    primary_category_id: '1',
    category_tags: ['AI', 'Business'],
    published_at: '2026-03-08T07:00:00Z',
  },
  {
    id: 'a2',
    title: "Google DeepMind Publishes AlphaFold 3: Protein–Ligand Structure Prediction at Scale",
    url: "https://deepmind.google/research",
    snippet: "DeepMind's AlphaFold 3 extends protein structure prediction to protein–ligand and protein–nucleic acid complexes, opening significant new possibilities for drug discovery pipelines. The paper is accompanied by an open-access model for academic use.",
    source: "Nature",
    primary_category_id: '1',
    category_tags: ['AI', 'IT'],
    published_at: '2026-03-08T06:30:00Z',
  },
  {
    id: 'a3',
    title: "EU AI Act Enforcement Begins: What Enterprises Need to Know",
    url: "https://ec.europa.eu/ai-act",
    snippet: "The EU AI Act's enforcement phase began March 1st, with high-risk AI system operators now required to maintain conformity assessments, human oversight logs, and incident reporting. Fines of up to 3% of global annual turnover apply for non-compliance.",
    source: "The Verge",
    primary_category_id: '1',
    category_tags: ['AI', 'Business'],
    published_at: '2026-03-08T08:00:00Z',
  },
  // IT
  {
    id: 'a4',
    title: "Apple M4 Ultra Benchmarks: On-Device AI Processing Crosses a New Threshold",
    url: "https://arstechnica.com/apple",
    snippet: "Early benchmarks for the M4 Ultra chip show 3.1x improvement in neural engine throughput versus M3 Ultra, enabling real-time on-device inference for 70B-parameter models. This changes the calculus for enterprises wary of cloud-based AI data exposure.",
    source: "Ars Technica",
    primary_category_id: '2',
    category_tags: ['IT', 'AI'],
    published_at: '2026-03-08T09:00:00Z',
  },
  {
    id: 'a5',
    title: "Google Cloud Launches Serverless PostgreSQL Tier with Auto-Scaling to Zero",
    url: "https://cloud.google.com",
    snippet: "Google Cloud's new AlloyDB Serverless tier scales to zero when idle and charges only for query execution time. Priced competitively against Neon and PlanetScale, it positions Google Cloud as a serious challenger for startup and edge-workload database needs.",
    source: "TLDR Newsletter",
    primary_category_id: '2',
    category_tags: ['IT', 'Business'],
    published_at: '2026-03-07T18:00:00Z',
  },
  {
    id: 'a6',
    title: "Linux Kernel 6.8 Introduces Memory Management Overhaul for AI Workloads",
    url: "https://lwn.net",
    snippet: "Linux 6.8 includes a significant rewrite of the memory management subsystem, introducing a new MGLRU-based allocator that improves performance on large-model inference workloads by up to 22% in benchmarks published by the kernel team.",
    source: "LWN.net",
    primary_category_id: '2',
    category_tags: ['IT'],
    published_at: '2026-03-07T14:00:00Z',
  },
  // Entrepreneurship
  {
    id: 'a7',
    title: "Y Combinator W26 Batch: 12 AI-Native Startups Redefining Vertical SaaS",
    url: "https://ycombinator.com/blog",
    snippet: "76% of YC's Winter 2026 batch are building AI-first products, a significant jump from the 54% in S25. The batch includes companies replacing entire job functions — not just augmenting them — in legal, accounting, HR, and supply chain.",
    source: "TechCrunch",
    primary_category_id: '3',
    category_tags: ['Entrepreneurship', 'AI', 'Business'],
    published_at: '2026-03-08T10:00:00Z',
  },
  {
    id: 'a8',
    title: "Sequoia Capital Closes $5.2B Climate Tech Fund, Its Largest Sector Bet",
    url: "https://sequoiacap.com",
    snippet: "Sequoia's new fund will focus on grid infrastructure, industrial decarbonization, and carbon removal — areas where regulatory tailwinds are strongest following the passage of the Global Carbon Levy in January. The fund is structured with a 15-year horizon.",
    source: "The Information",
    primary_category_id: '3',
    category_tags: ['Entrepreneurship', 'Business'],
    published_at: '2026-03-07T16:00:00Z',
  },
  {
    id: 'a9',
    title: "How Notion Grew to a $10B Valuation Without Traditional Performance Marketing",
    url: "https://notion.so/blog",
    snippet: "An in-depth look at Notion's product-led growth strategy: virality baked into templates, a freemium tier designed to convert teams rather than individuals, and a developer ecosystem that extended the platform's reach organically. Zero paid acquisition budget until Series C.",
    source: "Lenny's Newsletter",
    primary_category_id: '3',
    category_tags: ['Entrepreneurship', 'UX Design', 'Business'],
    published_at: '2026-03-08T07:30:00Z',
  },
  // UX Design
  {
    id: 'a10',
    title: "Figma Launches AI-Powered Component Suggestions in Beta",
    url: "https://figma.com/blog",
    snippet: "Figma's new 'Design Assist' feature analyzes your design context and suggests components from your organization's design system, reducing the time designers spend searching the component library by an estimated 40%. The feature uses a fine-tuned model trained on component metadata.",
    source: "UX Collective",
    primary_category_id: '4',
    category_tags: ['UX Design', 'AI', 'IT'],
    published_at: '2026-03-08T09:30:00Z',
  },
  {
    id: 'a11',
    title: "Apple Updates Human Interface Guidelines for visionOS 2.0 Spatial Computing",
    url: "https://developer.apple.com/design",
    snippet: "Apple's revised HIG introduces new patterns for 'volumetric depth' interactions — where UI elements occupy meaningful z-axis space rather than floating at a fixed distance. The guidelines explicitly discourage porting flat 2D interfaces and introduce a new 'spatial affordance' principle.",
    source: "9to5Mac",
    primary_category_id: '4',
    category_tags: ['UX Design', 'IT'],
    published_at: '2026-03-07T12:00:00Z',
  },
  {
    id: 'a12',
    title: "EU's Digital Fairness Act Bans 12 Dark Patterns in Consumer Interfaces",
    url: "https://ec.europa.eu",
    snippet: "The European Commission's new Digital Fairness Act, effective June 2026, explicitly bans 12 interface patterns including disguised ads, difficult-to-find unsubscribe flows, confirmshaming, and roach motel patterns. Companies have 6 months to audit and remediate affected interfaces.",
    source: "Smashing Magazine",
    primary_category_id: '4',
    category_tags: ['UX Design', 'Business'],
    published_at: '2026-03-08T11:00:00Z',
  },
  // Business
  {
    id: 'a13',
    title: "Amazon Q4 2025 Earnings: AWS Revenue Up 28% YoY to $117B Annually",
    url: "https://ir.aboutamazon.com",
    snippet: "Amazon's Q4 earnings beat analyst expectations across the board, with AWS posting 28% year-over-year growth driven primarily by AI workload contracts. CEO Andy Jassy cited 'unprecedented demand for GPU capacity' as the defining factor, noting a 14-month lead time for new data center capacity.",
    source: "Morning Brew",
    primary_category_id: '5',
    category_tags: ['Business', 'IT', 'AI'],
    published_at: '2026-03-07T21:00:00Z',
  },
  {
    id: 'a14',
    title: "OpenAI Valued at $157B in Latest Secondary Share Sale",
    url: "https://wsj.com",
    snippet: "OpenAI's latest secondary market transactions imply a valuation of $157B, up from $86B in mid-2024. The jump reflects investor repricing of AI infrastructure bets following GPT-5's commercial traction. Insiders note the valuation is now higher than Netflix and IBM combined.",
    source: "Wall Street Journal",
    primary_category_id: '5',
    category_tags: ['Business', 'AI', 'Entrepreneurship'],
    published_at: '2026-03-08T06:00:00Z',
  },
  {
    id: 'a15',
    title: "Stanford Remote Work Study: Hybrid Workers 13% More Productive Than Full-Office Peers",
    url: "https://siepr.stanford.edu",
    snippet: "A longitudinal study of 22,000 workers across 42 companies finds that 2–3 day hybrid schedules produce measurably higher output than either full-office or fully-remote arrangements. The productivity gains are largest for individual contributors in knowledge work roles.",
    source: "The Hustle",
    primary_category_id: '5',
    category_tags: ['Business', 'Entrepreneurship'],
    published_at: '2026-03-08T08:30:00Z',
  },
]

// Pre-generated analyses shown on first Dive (no API call needed initially)
export const ARTICLE_ANALYSES = {
  a1: {
    key_points: [
      "Claude 3.7 achieved a 34% improvement on multi-step reasoning benchmarks (MATH, GPQA) versus its predecessor.",
      "Gains come from improved chain-of-thought consistency, not just parameter scale — meaning smarter architecture, not just bigger models.",
      "Outperforms GPT-4o and Gemini Ultra on the tested benchmarks, though real-world task differences remain context-dependent.",
      "This directly impacts enterprise AI adoption decisions — better reasoning at the same cost tier shifts the calculus.",
    ],
    so_what: "This matters beyond the benchmark numbers. The shift from scale-driven to architecture-driven improvements signals that AI capability gains are becoming more efficient — more capability per dollar. For enterprises evaluating AI deployments, better reasoning means fewer error-correction loops and more reliable outputs on complex tasks like code review, legal analysis, and multi-step data pipelines.",
    implications: "Expect competing labs (Google, Meta, Mistral) to respond with their own reasoning-focused updates within 60–90 days. The benchmark race is intensifying precisely as enterprise contracts are being signed — companies locking in now will likely have renegotiation leverage in 12–18 months as the market matures.",
    interest_connections: [
      { category: 'Business', connection: "Enterprise AI contract pricing and ROI calculations are directly tied to capability benchmarks — this shifts the competitive landscape for AI vendors." },
      { category: 'IT', connection: "Better reasoning reduces the need for complex prompt engineering infrastructure, simplifying LLM integration patterns for engineering teams." },
    ],
  },
  a3: {
    key_points: [
      "EU AI Act enforcement began March 1st, covering high-risk AI system operators in the EU.",
      "Requirements include: conformity assessments, human oversight logs, and incident reporting protocols.",
      "Fines up to 3% of global annual turnover for non-compliance — significant for large enterprises.",
      "High-risk categories include AI used in hiring, credit scoring, biometric identification, and critical infrastructure.",
    ],
    so_what: "This is a watershed moment for enterprise AI governance. The Act creates a hard compliance boundary that separates companies with mature AI governance practices from those treating AI as an unmanaged experiment. For companies operating in Europe or processing EU citizen data, this is no longer optional — it's a legal cost of doing business with AI.",
    implications: "A new market for AI compliance tooling (audit trails, explainability layers, human-in-the-loop systems) is emerging. Expect incumbents like ServiceNow, IBM, and Palantir to aggressively market AI governance products. Startups building specifically for EU AI Act compliance are likely to see significant traction in H1 2026.",
    interest_connections: [
      { category: 'Business', connection: "Enterprises with EU operations face material compliance costs; this will show up in Q1 2026 earnings guidance as a new cost line." },
      { category: 'Entrepreneurship', connection: "Compliance tooling is a high-margin B2B SaaS opportunity — expect YC and a16z-backed startups to enter this space in the next 6 months." },
    ],
  },
}

export const SUGGESTED_QUESTIONS = [
  "What's the counterargument to this view?",
  "How does this connect to recent trends I've been following?",
  "What should I watch for in the next 30–90 days?",
  "Who are the key players involved here?",
  "What's the business model angle?",
]
