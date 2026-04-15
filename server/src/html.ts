// Frontend for THE TOKENDOME. Adapted from the Stitch export, with:
//  - Branded as THE TOKENDOME (Thunderdome for tokens)
//  - Static mock rows replaced with JS-driven rendering from /api/leaderboard
//  - Live WebSocket updates from /live
//  - Setup card values (agent token, install URL) filled from /me
export const HTML = /* html */ `<!DOCTYPE html>
<html class="dark" lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>THE TOKENDOME | Live LLM Leaderboard</title>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&amp;family=JetBrains+Mono:wght@400;700&amp;family=Inter:wght@400;500;600&amp;display=swap"/>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&amp;display=swap"/>
<style>
  .material-symbols-outlined { font-variation-settings: 'FILL' 0,'wght' 400,'GRAD' 0,'opsz' 24; vertical-align: middle; }
  body { font-family: 'Inter', sans-serif; background-color: #131318; }
  .font-headline { font-family: 'Space Grotesk', sans-serif; }
  .font-data { font-family: 'JetBrains Mono', monospace; font-variant-numeric: tabular-nums; }
  @keyframes pulse-emerald { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:.4; transform:scale(1.2); } }
  .animate-pulse-emerald { animation: pulse-emerald 1.5s cubic-bezier(.4,0,.6,1) infinite; }
  @keyframes flash { 0% { background:#facc15; } 100% { background:transparent; } }
  .flash { animation: flash 1.3s ease-out; }
  @media (prefers-reduced-motion: reduce) { .animate-pulse-emerald, .flash { animation: none !important; } }
</style>
<script id="tailwind-config">
tailwind.config = {
  darkMode: 'class',
  theme: { extend: {
    colors: {
      'error': '#ffb4ab',
      'surface': '#131318',
      'on-surface': '#e4e1e9',
      'on-surface-variant': '#d1c6ab',
      'on-primary': '#3c2f00',
      'outline-variant': '#4d4632',
      'outline': '#9a9078',
      'surface-container-lowest': '#0e0e13',
      'surface-container-low': '#1b1b20',
      'surface-container': '#1f1f24',
      'surface-container-high': '#2a292f',
      'surface-container-highest': '#35343a',
      'primary': '#ffecb9',
      'primary-container': '#facc15',
      'on-primary-container': '#6c5700',
      'secondary': '#4edea3',
      'secondary-fixed': '#6ffbbe',
      'secondary-fixed-dim': '#4edea3',
      'background': '#131318',
    },
    borderRadius: { DEFAULT: '.125rem', lg: '.25rem', xl: '.5rem', full: '.75rem' }
  }}
};
</script>
</head>
<body class="bg-surface text-on-surface selection:bg-primary-container selection:text-on-primary-container min-h-screen">

<!-- ╔════════════════════════════════════════════════════════════════╗
     ║ LANDING (signed-out view). Hidden once /me returns authed.     ║
     ╚════════════════════════════════════════════════════════════════╝ -->
<div id="landing" class="hidden">
  <header class="fixed top-0 w-full z-50 bg-[#131318]/80 backdrop-blur-xl shadow-2xl shadow-black/50">
    <div class="flex justify-between items-center px-8 h-20 w-full mx-auto max-w-[1440px]">
      <div class="flex items-center gap-8">
        <span class="text-2xl font-black tracking-tighter text-[#facc15] italic font-headline uppercase">⚡ THE TOKENDOME</span>
        <nav class="hidden md:flex gap-6 font-headline tracking-tighter uppercase font-bold text-xs">
          <a class="text-[#facc15] border-b-2 border-[#facc15] pb-1" href="#">Arena</a>
          <a class="text-zinc-500 hover:text-zinc-200" href="#coliseum">Leaderboard</a>
          <a class="text-zinc-500 hover:text-zinc-200" href="/install.sh">Install</a>
          <a class="text-zinc-500 hover:text-zinc-200" href="https://github.com/">Source</a>
        </nav>
      </div>
      <a href="/auth/github" class="flex items-center gap-2 px-6 py-2 bg-primary-container text-on-primary-container font-headline font-bold text-xs uppercase tracking-widest rounded-lg hover:brightness-110 active:scale-95 transition-all">
        <span class="material-symbols-outlined text-sm">terminal</span>
        Sign In with GitHub
      </a>
    </div>
  </header>

  <main class="pt-32 pb-20 px-4 md:px-8 max-w-[1440px] mx-auto min-h-screen">
    <!-- Hero -->
    <section class="mb-12 relative overflow-hidden">
      <div class="absolute -top-24 -right-24 w-96 h-96 bg-primary-container/10 blur-[120px] rounded-full"></div>
      <div class="flex flex-col md:flex-row justify-between items-end gap-8 border-b-4 border-primary-container pb-8">
        <div>
          <h1 class="text-6xl md:text-8xl font-black font-headline tracking-tighter leading-none mb-4 uppercase italic">
            BURN <span class="text-primary-container">TOKENS</span><br/>CLAIM GLORY.
          </h1>
          <p class="text-xl text-outline font-body max-w-2xl">
            Live leaderboard for LLM token burners. Model-agnostic. Proxy-verified. Two devs enter, one leaderboard leaves.
          </p>
          <p class="text-sm text-outline/60 font-body max-w-2xl mt-3">
            A local proxy reads the provider's own <code class="text-primary-container font-data">usage</code> field. No manual input. No guessing. No cheating.
          </p>
        </div>
        <div class="flex flex-col items-end">
          <div id="hero-throughput" class="text-primary-container font-data text-4xl font-bold tracking-tight">0</div>
          <div class="text-xs uppercase tracking-widest text-outline font-headline font-bold">Total Dome Throughput (tokens)</div>
        </div>
      </div>
    </section>

    <!-- Bento cards -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
      <div class="col-span-1 bg-surface-container-high p-6 rounded-lg flex flex-col justify-between h-48 hover:bg-surface-container-highest transition-colors">
        <div class="flex justify-between items-start">
          <span class="material-symbols-outlined text-primary-container text-3xl">bolt</span>
          <span id="hero-live-pill" class="text-[10px] bg-secondary-container/20 text-secondary px-2 py-1 rounded-full font-bold uppercase tracking-widest">connecting</span>
        </div>
        <div>
          <div id="hero-events-min" class="text-3xl font-data font-bold leading-none">—</div>
          <div class="text-xs uppercase tracking-widest text-outline mt-1">Events/Min</div>
        </div>
      </div>
      <div class="col-span-1 bg-surface-container-high p-6 rounded-lg flex flex-col justify-between h-48 hover:bg-surface-container-highest transition-colors">
        <div class="flex justify-between items-start">
          <span class="material-symbols-outlined text-primary-container text-3xl">hub</span>
        </div>
        <div>
          <div id="hero-combatants" class="text-3xl font-data font-bold leading-none">0</div>
          <div class="text-xs uppercase tracking-widest text-outline mt-1">Combatants</div>
        </div>
      </div>
      <div class="col-span-1 md:col-span-2 bg-primary-container p-6 rounded-lg flex flex-col justify-between h-48 overflow-hidden relative group">
        <div class="relative z-10 flex justify-between items-start text-on-primary-container">
          <span class="material-symbols-outlined text-3xl">workspace_premium</span>
          <div class="text-right">
            <div class="text-[10px] font-black uppercase tracking-widest leading-none">MVP of the Dome</div>
            <div id="hero-mvp-name" class="text-xl font-headline font-black italic">@awaiting_champion</div>
          </div>
        </div>
        <div class="relative z-10">
          <div id="hero-mvp-burn" class="text-4xl font-data font-black text-on-primary-container leading-none">—</div>
          <div class="text-xs uppercase tracking-widest text-on-primary-container/80 mt-1 font-bold">Personal Burn</div>
        </div>
        <div class="absolute -bottom-8 -right-8 opacity-10 scale-150 rotate-12 group-hover:rotate-0 transition-transform duration-700">
          <span class="material-symbols-outlined text-[200px]">trophy</span>
        </div>
      </div>
    </div>

    <!-- Coliseum preview (top 5 live) -->
    <div id="coliseum" class="bg-surface-container-lowest rounded-lg overflow-hidden">
      <div class="grid grid-cols-12 gap-4 px-8 py-4 bg-surface-container-high font-headline font-black text-[10px] uppercase tracking-[0.2em] text-outline italic">
        <div class="col-span-1">Rank</div>
        <div class="col-span-4 md:col-span-5">Burner</div>
        <div class="col-span-3 md:col-span-3">Primary Engine</div>
        <div class="col-span-3 md:col-span-2 text-right">Total Tokens</div>
        <div class="col-span-1 text-center">Status</div>
      </div>
      <div id="hero-rows"></div>
      <div id="hero-empty" class="hidden p-16 text-center">
        <p class="text-4xl font-headline font-black italic uppercase text-primary-container">The Dome Awaits Its First Champion</p>
        <p class="text-outline mt-3">No combatants yet. Be first. Glory is uncontested.</p>
      </div>
    </div>

    <!-- CTA panels -->
    <section class="mt-12 grid grid-cols-1 md:grid-cols-2 gap-8">
      <div class="bg-surface-container-high p-8 rounded-lg border-l-4 border-primary-container relative overflow-hidden">
        <h3 class="text-3xl font-black font-headline uppercase italic mb-4">Deploy Your Proxy</h3>
        <p class="text-outline mb-6">Sign in with GitHub, grab your agent token, point your LLM clients at localhost. We handle the rest. Your prompts never leave your machine.</p>
        <a href="/auth/github" class="inline-block bg-primary-container text-on-primary-container px-8 py-4 font-headline font-black uppercase tracking-tighter italic text-xl hover:scale-105 transition-transform active:scale-95">
          Enter the Dome →
        </a>
        <div class="absolute -bottom-10 -right-10 opacity-5"><span class="material-symbols-outlined text-[180px]">key</span></div>
      </div>
      <div class="bg-surface-container-high p-8 rounded-lg border-l-4 border-secondary relative overflow-hidden">
        <h3 class="text-3xl font-black font-headline uppercase italic mb-4">House Rules</h3>
        <div class="space-y-3 font-body">
          <div class="flex justify-between items-center bg-surface-container-lowest p-3 rounded">
            <span class="text-xs font-headline font-bold uppercase tracking-widest text-outline">Counts From</span>
            <span class="text-secondary font-data font-bold">PROVIDER USAGE</span>
          </div>
          <div class="flex justify-between items-center bg-surface-container-lowest p-3 rounded">
            <span class="text-xs font-headline font-bold uppercase tracking-widest text-outline">Prompt Content</span>
            <span class="text-secondary font-data font-bold">STAYS LOCAL</span>
          </div>
          <div class="flex justify-between items-center bg-surface-container-lowest p-3 rounded">
            <span class="text-xs font-headline font-bold uppercase tracking-widest text-outline">Manual Input</span>
            <span class="text-error font-data font-bold">REJECTED</span>
          </div>
          <div class="flex justify-between items-center bg-surface-container-lowest p-3 rounded">
            <span class="text-xs font-headline font-bold uppercase tracking-widest text-outline">Local Models</span>
            <span class="text-primary-container font-data font-bold">COUNT TOO</span>
          </div>
        </div>
      </div>
    </section>
  </main>

  <footer class="w-full border-t border-zinc-800/50 bg-[#131318]">
    <div class="flex flex-col md:flex-row justify-between items-center px-8 py-12 w-full max-w-[1440px] mx-auto">
      <div class="text-zinc-600 font-data text-xs uppercase tracking-widest mb-8 md:mb-0">
        ⚡ THE TOKENDOME // TWO DEVS ENTER, ONE LEADERBOARD LEAVES
      </div>
      <div class="flex gap-8 font-data text-xs uppercase tracking-widest">
        <a class="text-zinc-600 hover:text-[#facc15]" href="#">Terms of Combat</a>
        <a class="text-zinc-600 hover:text-[#facc15]" href="#">Privacy Protocol</a>
        <a class="text-zinc-600 hover:text-[#facc15]" href="https://github.com/">Source</a>
      </div>
    </div>
  </footer>
</div>

<!-- ╔════════════════════════════════════════════════════════════════╗
     ║ APP (signed-in view). Hidden until authed.                     ║
     ╚════════════════════════════════════════════════════════════════╝ -->
<div id="app" class="hidden">
<!-- Top nav -->
<header class="flex justify-between items-center px-6 h-16 w-full border-b border-primary-container/10 bg-[#131318] fixed top-0 z-50">
  <div class="flex items-center gap-6">
    <h1 class="text-2xl font-black tracking-tighter text-[#facc15] font-headline">⚡ THE TOKENDOME</h1>
    <div class="hidden lg:flex flex-col border-l border-outline-variant/30 pl-6">
      <span class="text-[10px] uppercase tracking-widest text-on-surface-variant font-headline font-bold">Verified Proxy Status</span>
      <p class="text-xs text-on-surface-variant">Two devs enter. One leaderboard leaves. Model-agnostic.</p>
    </div>
  </div>
  <div class="flex items-center gap-4">
    <div class="flex items-center gap-2 bg-secondary/10 px-3 py-1 border border-secondary/20">
      <span class="relative flex h-2 w-2">
        <span class="animate-pulse-emerald absolute inline-flex h-full w-full rounded-full bg-secondary opacity-75"></span>
        <span class="relative inline-flex rounded-full h-2 w-2 bg-secondary"></span>
      </span>
      <span id="rate" class="text-[10px] font-data font-bold text-secondary uppercase tracking-tighter">connecting…</span>
    </div>
    <div id="authbox"></div>
  </div>
</header>

<!-- Side nav -->
<nav class="fixed left-0 top-16 bottom-0 w-64 flex-col border-r border-primary-container/10 bg-[#131318] hidden md:flex">
  <div class="p-6 border-b border-primary-container/5">
    <h2 class="text-[#facc15] font-bold font-headline uppercase tracking-tighter text-sm">Dome Console</h2>
    <p class="text-[10px] font-data text-on-surface-variant">v0.1.0 · beta</p>
  </div>
  <div class="flex-1 py-4">
    <a href="#" data-tab="all_time" class="tab-link active flex items-center gap-3 px-6 py-3 text-[#facc15] bg-primary-container/10 font-bold border-r-4 border-[#facc15]">
      <span class="material-symbols-outlined">leaderboard</span>
      <span class="font-headline text-sm">Scoreboard</span>
    </a>
    <a href="#" data-tab="this_week" class="tab-link flex items-center gap-3 px-6 py-3 text-gray-500 hover:text-[#facc15]/70 hover:bg-[#1C1C21]">
      <span class="material-symbols-outlined">date_range</span>
      <span class="font-headline text-sm">This Week</span>
    </a>
    <a href="#" data-tab="local_hero" class="tab-link flex items-center gap-3 px-6 py-3 text-gray-500 hover:text-[#facc15]/70 hover:bg-[#1C1C21]">
      <span class="material-symbols-outlined">home_work</span>
      <span class="font-headline text-sm">Local Hero</span>
    </a>
    <a href="#" data-tab="by_provider" class="tab-link flex items-center gap-3 px-6 py-3 text-gray-500 hover:text-[#facc15]/70 hover:bg-[#1C1C21]">
      <span class="material-symbols-outlined">hub</span>
      <span class="font-headline text-sm">By Provider</span>
    </a>
  </div>
  <div class="p-6 mt-auto">
    <a href="https://github.com/" target="_blank" class="block text-center w-full bg-surface-container-highest border border-primary-container/20 text-[#facc15] py-2 font-headline text-xs font-bold hover:bg-primary-container/10 uppercase tracking-widest">
      Source on GitHub
    </a>
  </div>
</nav>

<main class="md:pl-64 pt-16 min-h-screen">
<div class="p-8 max-w-7xl mx-auto space-y-8">

  <!-- Setup card (hidden until signed in) -->
  <section id="setup" class="relative bg-primary-container/5 border border-primary-container/20 p-1 flex-col lg:flex-row gap-1 hidden">
    <button onclick="document.getElementById('setup').style.display='none'" class="absolute top-4 right-4 text-primary-container hover:scale-110 z-10">
      <span class="material-symbols-outlined">close</span>
    </button>
    <div class="flex-1 p-8 space-y-6">
      <div class="space-y-1">
        <h3 class="text-xl font-headline font-bold text-primary-container uppercase">Enter the Dome</h3>
        <p class="text-sm text-on-surface-variant">Bridge your local LLM traffic to the leaderboard. 60 seconds.</p>
      </div>
      <div class="space-y-4">
        <div class="space-y-2">
          <label class="text-[10px] uppercase font-bold text-primary-container tracking-widest font-headline flex items-center gap-2">
            <span class="w-4 h-4 rounded-full bg-primary-container text-on-primary text-[8px] flex items-center justify-center">1</span>
            Install CLI
          </label>
          <div class="bg-surface-container-lowest p-3 flex justify-between items-center group">
            <code id="install-cmd" class="font-data text-xs text-primary">curl -fsSL …/install.sh | bash</code>
            <button data-copy="install-cmd" class="copy-btn text-primary-container opacity-50 group-hover:opacity-100"><span class="material-symbols-outlined text-sm">content_copy</span></button>
          </div>
        </div>
        <div class="space-y-2">
          <label class="text-[10px] uppercase font-bold text-primary-container tracking-widest font-headline flex items-center gap-2">
            <span class="w-4 h-4 rounded-full bg-primary-container text-on-primary text-[8px] flex items-center justify-center">2</span>
            Agent Token <span class="text-on-surface-variant/70 normal-case font-normal">— keep secret</span>
          </label>
          <div class="bg-surface-container-lowest p-3 flex justify-between items-center group">
            <code id="token" class="font-data text-xs text-primary break-all">—</code>
            <button data-copy="token" class="copy-btn text-primary-container opacity-50 group-hover:opacity-100"><span class="material-symbols-outlined text-sm">content_copy</span></button>
          </div>
        </div>
        <div class="space-y-2">
          <label class="text-[10px] uppercase font-bold text-primary-container tracking-widest font-headline flex items-center gap-2">
            <span class="w-4 h-4 rounded-full bg-primary-container text-on-primary text-[8px] flex items-center justify-center">3</span>
            Point Your Tools at localhost
          </label>
          <div class="grid grid-cols-1 gap-1">
            <div class="bg-surface-container-lowest p-2 flex justify-between items-center group">
              <code id="env-openai" class="font-data text-[10px] text-primary">export OPENAI_BASE_URL="http://localhost:4000/v1"</code>
              <button data-copy="env-openai" class="copy-btn text-primary-container opacity-30 group-hover:opacity-100"><span class="material-symbols-outlined text-xs">content_copy</span></button>
            </div>
            <div class="bg-surface-container-lowest p-2 flex justify-between items-center group">
              <code id="env-anth" class="font-data text-[10px] text-primary">export ANTHROPIC_BASE_URL="http://localhost:4000"</code>
              <button data-copy="env-anth" class="copy-btn text-primary-container opacity-30 group-hover:opacity-100"><span class="material-symbols-outlined text-xs">content_copy</span></button>
            </div>
            <div class="bg-surface-container-lowest p-2 flex justify-between items-center group">
              <code id="env-ollama" class="font-data text-[10px] text-primary">export OLLAMA_HOST="http://localhost:4000"</code>
              <button data-copy="env-ollama" class="copy-btn text-primary-container opacity-30 group-hover:opacity-100"><span class="material-symbols-outlined text-xs">content_copy</span></button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="lg:w-1/3 p-4 bg-surface-container-lowest">
      <div class="h-full bg-black border border-outline-variant/30 overflow-hidden flex flex-col">
        <div class="bg-surface-container-high px-3 py-1.5 flex items-center gap-1.5">
          <div class="w-2.5 h-2.5 rounded-full bg-error/50"></div>
          <div class="w-2.5 h-2.5 rounded-full bg-primary-container/50"></div>
          <div class="w-2.5 h-2.5 rounded-full bg-secondary/50"></div>
          <span class="ml-2 text-[10px] font-data text-on-surface-variant">tokendome — bash — 80x24</span>
        </div>
        <div class="p-4 font-data text-xs space-y-1">
          <p class="text-secondary">$ tokenarena login &lt;your-token&gt;</p>
          <p class="text-on-surface/60">✓ logged in</p>
          <p class="text-secondary">$ tokenarena start</p>
          <p class="text-on-surface/60">Proxy: <span class="text-secondary">ACTIVE</span> on :4000</p>
          <p class="text-on-surface/60">Reporting: <span class="text-secondary">ENABLED</span></p>
          <p class="text-primary-container mt-2"># fire up Claude / GPT / Ollama normally</p>
          <div class="flex items-center gap-1"><span class="text-on-surface">_</span><span class="w-2 h-4 bg-primary-container animate-pulse"></span></div>
        </div>
      </div>
    </div>
  </section>

  <!-- Scoreboard header -->
  <div class="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b-4 border-primary-container pb-4">
    <div class="space-y-1">
      <div class="flex items-center gap-3">
        <span class="bg-primary-container text-on-primary px-2 py-0.5 text-xs font-bold font-headline uppercase">Live</span>
        <h2 id="scoreboard-title" class="text-4xl font-headline font-black italic tracking-tighter uppercase">Scoreboard</h2>
      </div>
      <p class="text-on-surface-variant font-data text-sm">Telemetry updated every 3s · provider-verified counts</p>
    </div>
    <div class="flex gap-2">
      <button class="px-4 py-1.5 bg-surface-container-highest border border-outline-variant/50 text-xs font-headline font-bold uppercase tracking-widest">Season 1</button>
      <button class="px-4 py-1.5 bg-primary-container text-on-primary text-xs font-headline font-bold uppercase tracking-widest">Global</button>
    </div>
  </div>

  <!-- Leaderboard -->
  <div class="space-y-1">
    <div id="head-row" class="grid grid-cols-12 gap-4 px-6 py-2 bg-surface-container-high text-[10px] font-headline font-black uppercase tracking-widest text-on-surface-variant">
      <div class="col-span-1">Rank</div>
      <div class="col-span-5">Combatant</div>
      <div class="col-span-2 text-right">Total Tokens</div>
      <div class="col-span-2 text-right">Providers</div>
      <div class="col-span-2 text-right">Burn Share</div>
    </div>
    <div id="board" class="space-y-1"></div>
    <div id="empty" class="hidden p-12 text-center bg-surface-container-low border border-outline-variant/20">
      <p class="text-3xl font-headline font-black italic uppercase text-primary-container">The Arena Is Empty</p>
      <p class="text-on-surface-variant mt-2">Be first. Install the agent, fire up your model, watch yourself crown.</p>
    </div>
  </div>

  <!-- Bento stats -->
  <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
    <div class="bg-surface-container-low border border-outline-variant/20 p-6">
      <span class="text-[10px] font-headline font-black uppercase tracking-[0.2em] text-on-surface-variant">Arena Throughput</span>
      <div class="mt-4">
        <p class="text-4xl font-data font-bold text-primary-container tracking-tighter" id="stat-throughput">—<span class="text-sm font-normal text-on-surface-variant"> tok total</span></p>
        <p class="text-xs text-secondary mt-1 flex items-center gap-1"><span class="material-symbols-outlined text-xs">trending_up</span> <span id="stat-throughput-delta">awaiting telemetry</span></p>
      </div>
    </div>
    <div class="bg-surface-container-low border border-outline-variant/20 p-6">
      <span class="text-[10px] font-headline font-black uppercase tracking-[0.2em] text-on-surface-variant">Combatants</span>
      <div class="mt-4">
        <p class="text-4xl font-data font-bold text-on-surface tracking-tighter" id="stat-users">—</p>
        <p class="text-xs text-on-surface-variant mt-1" id="stat-users-sub">signed up and ready to burn</p>
      </div>
    </div>
    <div class="bg-primary-container p-6 flex flex-col justify-between group overflow-hidden relative">
      <div class="absolute -right-4 -bottom-4 rotate-12 opacity-10"><span class="material-symbols-outlined text-8xl">trophy</span></div>
      <span class="text-[10px] font-headline font-black uppercase tracking-[0.2em] text-on-primary">Current Champion</span>
      <div class="mt-4 z-10">
        <p class="text-xl font-headline font-black uppercase leading-tight text-on-primary" id="stat-champ">—</p>
        <p class="text-xs text-on-primary/70 mt-1 font-bold" id="stat-champ-sub">first to claim the dome takes the crown</p>
      </div>
    </div>
  </div>

  <footer class="text-center text-[10px] text-on-surface-variant/70 pt-8 pb-12 font-data uppercase tracking-widest">
    prompts never leave your machine · counts come from provider usage fields · no manual input
  </footer>
</div>
</main>
</div><!-- /#app -->

<!-- Row template: cloned per leaderboard entry -->
<template id="row-tpl">
  <div class="group relative grid grid-cols-12 items-center gap-4 px-6 py-4 bg-surface-container-low hover:bg-surface-container-highest transition-all duration-300 border-l-8 border-outline-variant/30">
    <div class="col-span-1 font-headline font-black italic text-on-surface-variant" data-rank></div>
    <div class="col-span-5 flex items-center gap-4">
      <img class="w-10 h-10 border border-outline-variant/30 object-cover" data-avatar alt=""/>
      <div>
        <p class="font-headline font-bold uppercase tracking-tighter" data-login></p>
        <p class="text-[10px] font-data text-secondary uppercase" data-sub>—</p>
      </div>
    </div>
    <div class="col-span-2 text-right">
      <p class="font-data font-bold tracking-tighter text-on-surface" data-total></p>
      <p class="text-[10px] font-data text-on-surface-variant" data-breakdown></p>
    </div>
    <div class="col-span-2 text-right">
      <div class="flex justify-end gap-1 flex-wrap" data-providers></div>
    </div>
    <div class="col-span-2 pl-4">
      <div class="flex justify-between items-center mb-1"><span class="text-[10px] font-headline font-bold" data-share-label></span></div>
      <div class="h-3 bg-black/40 border border-outline-variant/30 p-0.5">
        <div class="h-full bg-on-surface-variant/50" data-bar style="width:0%"></div>
      </div>
    </div>
  </div>
</template>

<script>
const PROVIDER_COLORS = {
  openai:    'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  anthropic: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  google:    'bg-blue-500/20 text-blue-300 border-blue-500/30',
  ollama:    'bg-purple-500/20 text-purple-300 border-purple-500/30',
};
const fmt = new Intl.NumberFormat();
const fmtCompact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let state = { all_time: [], this_week: [], local_hero: [], by_provider: [] };
let active = 'all_time';
let userProviders = {}; // login -> { provider: tokens }
let eventsThisMinute = 0;

// ────── Render ──────
function render() {
  const board = document.getElementById('board');
  const empty = document.getElementById('empty');
  const headRow = document.getElementById('head-row');
  board.innerHTML = '';

  if (active === 'by_provider') {
    headRow.style.display = 'none';
    empty.classList.add('hidden');
    const groups = {};
    for (const r of state.by_provider) (groups[r.provider] ||= []).push(r);
    const wrap = document.createElement('div');
    wrap.className = 'grid md:grid-cols-2 gap-4';
    for (const [prov, list] of Object.entries(groups)) {
      const color = PROVIDER_COLORS[prov] || 'bg-gray-500/20 text-gray-300';
      const col = document.createElement('div');
      col.className = 'bg-surface-container-low border border-outline-variant/20 p-4';
      col.innerHTML = '<h3 class="font-headline font-black uppercase mb-3 flex items-center gap-2"><span class="px-2 py-0.5 text-[10px] border ' + color + '">' + esc(prov) + '</span></h3>';
      const ol = document.createElement('ol');
      ol.className = 'space-y-1 font-data text-sm';
      list.slice(0, 10).forEach((r, i) => {
        const li = document.createElement('li');
        li.className = 'flex justify-between text-on-surface';
        li.innerHTML = '<span class="text-on-surface-variant">' + (i+1) + '. ' + esc(r.login) + '</span><span class="font-bold">' + fmt.format(r.total) + '</span>';
        ol.appendChild(li);
      });
      col.appendChild(ol);
      wrap.appendChild(col);
    }
    board.appendChild(wrap);
    return;
  }

  headRow.style.display = '';
  const rows = state[active] || [];
  if (rows.length === 0) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  const tpl = document.getElementById('row-tpl');
  const topShare = rows[0] ? (Number(rows[0].total) || 1) : 1;
  rows.forEach((r, i) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.login = r.login;
    // first-place treatment
    if (i === 0) {
      node.classList.remove('border-outline-variant/30');
      node.classList.add('border-primary-container', 'py-6');
      const rankEl = node.querySelector('[data-rank]');
      rankEl.className = 'col-span-1 font-headline font-black italic text-4xl text-primary-container';
    }
    node.querySelector('[data-rank]').textContent = String(i + 1).padStart(2, '0');
    const avatar = node.querySelector('[data-avatar]');
    avatar.src = r.avatar_url || '';
    avatar.alt = r.login;
    node.querySelector('[data-login]').textContent = r.login;
    node.querySelector('[data-sub]').textContent = 'Active · total: ' + fmtCompact.format(r.total || 0);
    node.querySelector('[data-total]').textContent = fmt.format(r.total || 0);
    if (r.total_input != null) {
      node.querySelector('[data-breakdown]').textContent = fmtCompact.format(r.total_input) + ' in · ' + fmtCompact.format(r.total_output) + ' out';
    } else {
      node.querySelector('[data-breakdown]').textContent = '';
    }
    // provider chips
    const provBox = node.querySelector('[data-providers]');
    const provs = userProviders[r.login] || {};
    const sortedProvs = Object.entries(provs).sort((a,b)=>b[1]-a[1]).slice(0,3);
    if (sortedProvs.length === 0) {
      provBox.innerHTML = '<span class="text-[10px] text-on-surface-variant/40 font-data">—</span>';
    } else {
      for (const [p] of sortedProvs) {
        const chip = document.createElement('span');
        chip.className = 'text-[9px] px-1.5 py-0.5 border uppercase font-data font-bold ' + (PROVIDER_COLORS[p] || 'bg-gray-500/20 text-gray-300');
        chip.textContent = p;
        provBox.appendChild(chip);
      }
    }
    // burn share
    const share = Math.round(((Number(r.total) || 0) / topShare) * 100);
    node.querySelector('[data-share-label]').textContent = share + '%';
    const bar = node.querySelector('[data-bar]');
    bar.style.width = share + '%';
    if (i === 0) bar.className = 'h-full bg-primary-container';
    document.getElementById('board').appendChild(node);
  });
}

function updateBento() {
  const rows = state.all_time || [];
  const total = rows.reduce((s, r) => s + (Number(r.total) || 0), 0);
  document.getElementById('stat-throughput').innerHTML =
    (total ? fmtCompact.format(total) : '0') + '<span class="text-sm font-normal text-on-surface-variant"> tok total</span>';
  document.getElementById('stat-throughput-delta').textContent =
    eventsThisMinute ? (eventsThisMinute + ' events/min') : 'awaiting telemetry';
  document.getElementById('stat-users').textContent = rows.length ? fmt.format(rows.length) : '—';
  if (rows[0]) {
    document.getElementById('stat-champ').textContent = '@' + rows[0].login;
    document.getElementById('stat-champ-sub').textContent = fmt.format(rows[0].total) + ' tokens burned';
  }
}

const SCOREBOARD_TITLES = {
  all_time: 'Scoreboard',
  this_week: 'This Week',
  local_hero: 'Local Heroes',
  by_provider: 'By Provider',
};
function setActive(tab) {
  active = tab;
  document.getElementById('scoreboard-title').textContent = SCOREBOARD_TITLES[tab];
  document.querySelectorAll('.tab-link').forEach(a => {
    if (a.dataset.tab === tab) {
      a.className = 'tab-link flex items-center gap-3 px-6 py-3 text-[#facc15] bg-primary-container/10 font-bold border-r-4 border-[#facc15]';
    } else {
      a.className = 'tab-link flex items-center gap-3 px-6 py-3 text-gray-500 hover:text-[#facc15]/70 hover:bg-[#1C1C21]';
    }
  });
  render();
}

// ────── Data ──────
async function fetchBoard() {
  const r = await fetch('/api/leaderboard').then(r => r.json());
  state = r;
  // Index per-user provider breakdown for chips
  userProviders = {};
  for (const row of (r.by_provider || [])) {
    (userProviders[row.login] ||= {})[row.provider] = Number(row.total) || 0;
  }
  render();
  updateBento();
  renderLanding();
}

async function fetchMe() {
  const m = await fetch('/me').then(r => r.json());
  const landing = document.getElementById('landing');
  const app = document.getElementById('app');
  if (!m.authenticated) {
    landing.classList.remove('hidden');
    app.classList.add('hidden');
    return;
  }
  landing.classList.add('hidden');
  app.classList.remove('hidden');
  const box = document.getElementById('authbox');
  box.innerHTML = '<div class="flex items-center gap-2">'
    + '<img src="' + esc(m.avatar_url) + '" class="w-8 h-8 border border-primary-container/30"/>'
    + '<span class="font-headline text-sm font-bold">@' + esc(m.login) + '</span>'
    + '<form method="POST" action="/auth/logout"><button class="text-[10px] text-on-surface-variant underline ml-2">sign out</button></form>'
    + '</div>';
  const setup = document.getElementById('setup');
  setup.style.display = 'flex';
  document.getElementById('token').textContent = m.agent_token;
  document.getElementById('install-cmd').textContent = 'curl -fsSL ' + location.origin + '/install.sh | bash';
}

// Landing view renderer — shows top 5 combatants + hero stats
const LANDING_ROW_BG = ['bg-[#F8FAFC]', 'bg-[#F8FAFC]/95', 'bg-[#F8FAFC]/90', 'bg-[#F8FAFC]/85', 'bg-[#F8FAFC]/80'];
const LANDING_RANK_OPACITY = ['', 'opacity-50', 'opacity-30', 'opacity-20', 'opacity-10'];
function renderLanding() {
  if (document.getElementById('landing').classList.contains('hidden')) return;
  const rows = state.all_time || [];
  const total = rows.reduce((s, r) => s + (Number(r.total) || 0), 0);
  document.getElementById('hero-throughput').textContent = total ? fmt.format(total) : '0';
  document.getElementById('hero-combatants').textContent = fmt.format(rows.length);
  document.getElementById('hero-events-min').textContent = eventsThisMinute || '—';
  document.getElementById('hero-live-pill').textContent = eventsThisMinute ? 'LIVE NOW' : 'STANDBY';
  if (rows[0]) {
    document.getElementById('hero-mvp-name').textContent = '@' + rows[0].login.toUpperCase();
    document.getElementById('hero-mvp-burn').textContent = fmtCompact.format(rows[0].total || 0);
  }
  const coliseum = document.getElementById('hero-rows');
  const empty = document.getElementById('hero-empty');
  coliseum.innerHTML = '';
  if (rows.length === 0) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  rows.slice(0, 5).forEach((r, i) => {
    const primaryProvider = Object.entries(userProviders[r.login] || {}).sort((a,b)=>b[1]-a[1])[0];
    const engine = primaryProvider ? primaryProvider[0].toUpperCase() : '—';
    const div = document.createElement('div');
    div.className = 'grid grid-cols-12 gap-4 px-8 py-6 items-center ' + LANDING_ROW_BG[i] + ' text-[#131318] group border-b border-surface-container-lowest';
    div.dataset.login = r.login;
    div.innerHTML =
      '<div class="col-span-1 font-headline font-black text-4xl italic leading-none ' + LANDING_RANK_OPACITY[i] + '">' + String(i+1).padStart(2,'0') + '</div>'
      + '<div class="col-span-4 md:col-span-5 flex items-center gap-4">'
        + (r.avatar_url ? '<img src="' + esc(r.avatar_url) + '" class="w-12 h-12 rounded-lg bg-[#131318] object-cover"/>' : '<div class="w-12 h-12 rounded-lg bg-[#131318]"></div>')
        + '<div>'
          + '<div class="font-headline font-black text-lg leading-none uppercase">' + esc(r.login) + '</div>'
          + '<div class="text-[10px] font-data text-outline-variant font-bold uppercase">' + fmtCompact.format(r.total || 0) + ' tokens</div>'
        + '</div>'
      + '</div>'
      + '<div class="col-span-3 md:col-span-3"><span class="px-3 py-1 bg-[#131318] text-primary-container text-[10px] font-black font-headline uppercase tracking-widest rounded-lg">' + esc(engine) + '</span></div>'
      + '<div class="col-span-3 md:col-span-2 text-right font-data text-2xl font-bold tracking-tight">' + fmtCompact.format(r.total || 0) + '</div>'
      + '<div class="col-span-1 flex justify-center">'
        + '<div class="relative flex h-3 w-3">'
          + '<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-secondary opacity-75"></span>'
          + '<span class="relative inline-flex rounded-full h-3 w-3 bg-secondary"></span>'
        + '</div>'
      + '</div>';
    coliseum.appendChild(div);
  });
}

// ────── Copy buttons ──────
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  const target = document.getElementById(btn.dataset.copy);
  if (!target) return;
  navigator.clipboard.writeText(target.textContent.trim());
  const icon = btn.querySelector('.material-symbols-outlined');
  const prev = icon.textContent;
  icon.textContent = 'check';
  setTimeout(() => { icon.textContent = prev; }, 900);
});
document.querySelectorAll('.tab-link').forEach(a => {
  a.addEventListener('click', (e) => { e.preventDefault(); setActive(a.dataset.tab); });
});

// ────── Live updates ──────
let evCounterReset;
function bumpEventRate() {
  eventsThisMinute++;
  document.getElementById('rate').textContent = eventsThisMinute + ' events/min';
  clearTimeout(evCounterReset);
  evCounterReset = setTimeout(() => { eventsThisMinute = 0; document.getElementById('rate').textContent = 'idle'; }, 60_000);
}
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(proto + '://' + location.host + '/live');
  ws.onopen = () => { document.getElementById('rate').textContent = 'live'; };
  ws.onclose = () => {
    document.getElementById('rate').textContent = 'reconnecting';
    setTimeout(connectWS, 2000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    bumpEventRate();
    // optimistic bump
    const u = msg.user;
    const entry = state.all_time.find(r => r.login === u.login);
    if (entry) {
      entry.total_input = (Number(entry.total_input) || 0) + msg.delta.input;
      entry.total_output = (Number(entry.total_output) || 0) + msg.delta.output;
      entry.total = entry.total_input + entry.total_output;
    } else {
      state.all_time.push({
        login: u.login, avatar_url: u.avatar_url,
        total_input: msg.delta.input, total_output: msg.delta.output,
        total: msg.delta.input + msg.delta.output, local_tokens: msg.delta.local,
      });
    }
    state.all_time.sort((a, b) => (Number(b.total)||0) - (Number(a.total)||0));
    render(); updateBento(); renderLanding();
    const row = document.querySelector('#board > [data-login="' + CSS.escape(u.login) + '"]');
    if (row) row.classList.add('flash');
    clearTimeout(connectWS._t);
    connectWS._t = setTimeout(fetchBoard, 1500);
  };
}

// ────── Boot ──────
fetchMe();
fetchBoard();
connectWS();
setInterval(fetchBoard, 30000);
</script>
</body>
</html>`;
