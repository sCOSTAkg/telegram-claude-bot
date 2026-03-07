# sCORP Prison UI/UX Design Variants

**Design Date**: 2026-03-02
**Target**: Agent management dashboard with real-time monitoring

---

## Current State Analysis (from REDESIGN_SUMMARY.md)

### What Works Well
- Cyberpunk aesthetic resonates with users
- Color scheme (cyan, green, red, yellow) is distinctive
- Information hierarchy is present
- Responsive to mobile and desktop

### What Needs Improvement
- Cognitive load: 75/140 (too high)
- Information overload in dense layout
- Missing real-time metrics
- No clear task queue visibility
- Agent status unclear at glance

---

## Design Variant A: Modern Dashboard

### Overview
Modern, minimalist dashboard with real-time metrics and clear task visualization.
**Target Users**: Technical users who want maximum information density
**Color Palette**: Updated cyberpunk with better contrast

### Key Features
1. **Top Bar**: System health at a glance
2. **Agent Cards**: Real-time status with progress bars
3. **Task Queue**: Visual pipeline of pending/running/completed
4. **Metrics Panel**: Charts and statistics
5. **Sidebar**: Quick controls and settings

### Visual Layout
```
┌─────────────────────────────────────────────────────────────┐
│ sCORP Prison Control       🟢 System OK    ⚠️ 2 Warnings     │
├──────────────┬──────────────────────────────────────────────┤
│              │                                              │
│ AGENTS       │            TASK QUEUE                        │
│              │  ┌─────────────────────────────────────────┐ │
│ 🤖 Claude    │  │ Running: 3 tasks                        │ │
│ ⚡ Groq      │  ├─────────────────────────────────────────┤ │
│ 🔮 Gemini   │  │ [████████  ] Query AI Models      75%   │ │
│ 🧠 OpenAI   │  │ [██████    ] Generate Response   55%   │ │
│              │  │ [████      ] Memory Processing   35%   │ │
│ API HEALTH   │  │                                         │ │
│ Google  ✅   │  │ Pending: 5 tasks                        │ │
│ OpenAI  ✅   │  │ ┌─────────────────────────────────────┐ │ │
│ Groq    ⚠️   │  │ • Parse user message                  │ │ │
│              │  │ • Check memory                         │ │ │
│              │  │ • Build context                        │ │ │
│              │  │ • Query API                            │ │ │
│              │  │ • Format response                      │ │ │
│              │  └─────────────────────────────────────────┘ │ │
│ CONTROLS     │                                              │
│ [⚙️] Settings│                 METRICS                     │
│ [🧠] Memory │  ┌────────────────────────────────────────┐  │
│ [📊] Metrics│  │ API Response Time: 2.3s (avg)          │  │
│ [🛑] Shutdown│ │ Success Rate: 95.02%                   │  │
│              │  │ Memory Used: 145MB / 200MB             │  │
│              │  │ Uptime: 15d 8h 23m                     │  │
│              │  └────────────────────────────────────────┘  │
└──────────────┴──────────────────────────────────────────────┘
```

### Color Scheme
```
Primary:    #00e5ff (Bright Cyan)     - Active, Interactive
Success:    #00ff88 (Bright Green)    - Complete, Healthy
Warning:    #ffc400 (Golden Yellow)   - Caution
Error:      #ff3d3d (Bright Red)      - Critical
Idle:       #6b5b95 (Purple)          - Inactive
Background: #0a0e27 (Deep Blue-Black) - Dark base
Card:       #1a1f3a (Darker Blue)     - Content areas
Text:       #e0e0e0 (Light Gray)      - Primary text
```

### Typography
```
Headlines:    Inter Bold, 20-24px, Letter spacing: 1px
Subheads:     Inter Semi-bold, 14-16px
Body:         Inter Regular, 12-14px, Line height: 1.6
Monospace:    Courier New, 11-13px, For metrics/data
```

### Interactions
- Click agent card → Show detailed metrics
- Click task → Show task details/logs
- Hover over status → Show last error/reason
- Real-time updates every 500ms (smoothed with CSS transitions)

### Mobile Responsiveness
- Sidebar → Bottom tab bar (600px breakpoint)
- Agent cards → Stack vertically
- Task queue → Horizontal scroll
- Metrics → Collapse into expandable sections

---

## Design Variant B: Cyberpunk Enhanced (Current Evolution)

### Overview
Evolved version of current design with better organization and clarity.
**Target Users**: Users who love the cyberpunk aesthetic
**Maintains**: Current color scheme and style

### Key Improvements
1. **Grid Layout**: Better organization
2. **Scanlines Effect**: Enhanced cyberpunk vibe
3. **Agent Status Matrix**: Visual status at glance
4. **Better Typography**: Clearer hierarchy
5. **Glow Effects**: Subtle, not overwhelming

### Visual Layout
```
╔══════════════════════════════════════════════════════════════╗
║ ▓▓▓ sCORP PRISON v2.1 ▓▓▓  [SYSTEM ONLINE]  [⚠️ WARNING]    ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  AGENT STATUS GRID                  REAL-TIME ACTIVITY LOG  ║
║  ┌──────────┐ ┌──────────┐         ┌─────────────────────┐ ║
║  │ 🤖 CLAUDE│ │ ⚡ GROQ  │         │ [23:27] Claude task │ ║
║  │ ✅ READY │ │ ✅ READY │         │ [23:26] Memory OK   │ ║
║  │ 0.8s ago │ │ 0.2s ago │         │ [23:25] API OK      │ ║
║  │ [CPU: 15%]         │         │ [23:24] Groq resp  │ ║
║  └──────────┘ └──────────┘         └─────────────────────┘ ║
║  ┌──────────┐ ┌──────────┐                                  ║
║  │ 🔮 GEMINI│ │ 🧠 OPENAI│         QUEUE STATUS             ║
║  │ ✅ READY │ │ ⚠️ BUSY  │         Running: ███░░ 3/5      ║
║  │ 1.2s ago │ │ 2.5s ago │         Pending: ██░░░░ 2/8     ║
║  │ [CPU: 25%]          │         Completed: ██████ 12     ║
║  └──────────┘ └──────────┘                                  ║
║                                                              ║
║  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ║
║                                                              ║
║  TASK DETAILS (CURRENT)                   SYSTEM METRICS    ║
║  Task ID: ag-2026-03-02-001              Memory: 145MB      ║
║  Model: claude-opus-4-6                   Uptime: 15d       ║
║  Status: Processing [████████░░] 85%     API Calls: 2.4k   ║
║  Time: 1.2s / 5.0s timeout               Success: 95.02%   ║
║  Input: 256 tokens | Output: 512 tokens  Errors: 4.98%     ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```

### Implementation Details
- Scanline effect: CSS overlay with opacity animation
- Glow effect: Box-shadow with theme colors
- Font: Courier New for retro feel
- Status indicators: Unicode symbols + color coding
- Progress bars: Block characters (▓░)

### Mobile Version
- Vertical layout (same info, stacked)
- Touch-friendly buttons (48x48px minimum)
- Swipe between agent details
- Bottom sheet for queue

---

## Design Variant C: Minimalist Console

### Overview
Ultra-minimal text-based interface, maximizes information per character.
**Target Users**: Terminal/command-line enthusiasts
**Philosophy**: Information-first, no decorations

### Visual Layout
```
sCORP PRISON CONTROL

AGENTS
  claude      UP  0.8s  cpu:15%  mem:28MB
  groq        UP  0.2s  cpu:5%   mem:12MB
  gemini      UP  1.2s  cpu:22%  mem:35MB
  openai      DLY 2.5s  err:rate-limit

QUEUE (3 running, 5 pending, 12 done)
  [RUN] ag-001  0.8s  claude  query_ai      [████████░░] 85%
  [RUN] ag-002  1.5s  groq    generate_res  [██████░░░░] 60%
  [RUN] ag-003  0.3s  gemini  memory_chk    [██░░░░░░░░] 20%
  [PND] ag-004  groq  parse_message
  [PND] ag-005  claude build_context
  [DONE] ag-006 1.2s (15m ago)

SYSTEM
  uptime:      15 days 8 hours
  memory:      145 MB / 200 MB (72%)
  api_calls:   2,400 / day
  success:     95.02% (4,970 success / 4,974 total)
  errors:      ENOTFOUND (4,971) | TIMEOUT (3)

COMMANDS
  :help        :status [agent]  :logs [lines]  :restart [agent]
  :memory      :config          :quit
```

### CSS Styling
```css
/* Minimalist */
- Monospace font (Courier New)
- Simple text colors (cyan for status, yellow for warning)
- No decorative elements
- Max 80 characters per line (terminal style)
- All data in tabular format
```

### Advantages
- Fast to parse visually
- Extremely accessible (high contrast)
- Works in terminal emulators
- Minimal CSS/JS overhead
- Perfect for monitoring on small screens

---

## Comparison Matrix

| Aspect | Variant A | Variant B | Variant C |
|--------|-----------|-----------|-----------|
| **Aesthetic** | Modern | Cyberpunk | Minimal |
| **Complexity** | High (medium learning) | Medium | Low |
| **Data Density** | High | High | Very High |
| **Mobile Friendly** | Excellent | Good | Excellent |
| **Accessibility** | Good (WCAG AA) | Fair (colors) | Excellent |
| **Load Time** | 1.2s | 0.8s | 0.3s |
| **CSS Size** | 25KB | 15KB | 3KB |
| **Target Audience** | Tech-savvy | Gamers/Cyberpunk | DevOps/Minimal |
| **Development Effort** | 40 hours | 20 hours | 15 hours |
| **Maintenance** | Higher | Medium | Low |

---

## Recommended Variant

**Recommendation: Variant B (Cyberpunk Enhanced)**

### Rationale
1. Builds on existing design (less rewrite)
2. Addresses key usability issues (clarity, hierarchy)
3. Maintains visual identity users love
4. Moderate development effort (20 hours)
5. Good balance of form and function
6. Keeps cyberpunk aesthetic

### Implementation Roadmap
- **Week 1**: Implement grid layout and agent status matrix
- **Week 2**: Add real-time metrics panel and activity log
- **Week 3**: Optimize mobile experience
- **Week 4**: Add animations and polish

---

## Component Library

### Agent Status Card
```
┌─────────────────────────┐
│ 🤖 CLAUDE              │
│ STATUS: ✅ READY       │
│ LAST SEEN: 0.8s ago    │
│                         │
│ CPU Usage:   ███░░ 15% │
│ Response:    1.2s      │
│ Success:     98%       │
│ Tasks Done:  42        │
│                         │
│ [Config] [Logs] [Stop] │
└─────────────────────────┘
```

### Task Progress Bar
```
Task: Generate Response
[████████░░░░] 67% Complete (4.5s / 8.0s)
```

### System Health Indicator
```
🟢 All Systems OK
🟡 1 Warning (Groq rate limited)
🔴 1 Error (OpenAI timeout)
```

### Status Badges
```
✅ READY     - Agent online and idle
⚡ ACTIVE    - Currently processing
⏳ WAITING   - In queue
⚠️ WARNING   - Rate limited or slow
❌ OFFLINE   - Not responding
```

---

## Implementation Checklist

### HTML/CSS Structure
- [ ] Base layout grid (sidebar + main + right panel)
- [ ] Agent status cards (grid layout)
- [ ] Task queue (timeline/pipeline view)
- [ ] Metrics panel (gauges and charts)
- [ ] Real-time updates (WebSocket or polling)

### JavaScript Features
- [ ] Update agent status every 500ms
- [ ] Animate progress bars
- [ ] Show/hide task details on click
- [ ] Handle window resize (responsive)
- [ ] Keyboard shortcuts (optional)

### Accessibility
- [ ] Color contrast > 4.5:1
- [ ] ARIA labels on all interactive elements
- [ ] Keyboard navigation support
- [ ] Screen reader friendly
- [ ] Motion respect (prefers-reduced-motion)

### Performance
- [ ] Minimize DOM updates
- [ ] Use CSS animations (not JS)
- [ ] Lazy load metrics charts
- [ ] Virtual scrolling for task list
- [ ] Cache static assets

---

## Integration with bot.js

### Required Data Structure
```javascript
// Bot should provide this data via API
{
  timestamp: 2026-03-02T23:27:00Z,
  agents: [
    {
      name: 'claude',
      status: 'ready', // ready, active, waiting, warning, offline
      lastSeen: 0.8, // seconds ago
      cpuUsage: 15,
      memoryUsage: 28,
      successRate: 98,
      tasksDone: 42
    }
  ],
  queue: {
    running: [
      {
        id: 'ag-001',
        model: 'claude-opus-4-6',
        taskType: 'query_ai',
        progress: 85,
        elapsed: 0.8,
        timeout: 5.0
      }
    ],
    pending: [...],
    completed: [...]
  },
  metrics: {
    uptime: 1329600000, // milliseconds
    memory: { used: 145, max: 200 },
    apiCalls: { total: 2400, last24h: 1200 },
    success: { rate: 95.02, count: 4970 },
    errors: { rate: 4.98, count: 4974 }
  }
}
```

### Telegram Bot API Integration
```javascript
// Implement these handlers in bot.js
async function getSystemStatus() {
  return { agents, queue, metrics }; // Return above structure
}

async function getAgentDetails(agentName) {
  return { ...agentData, logs: [...] };
}

async function handleDashboardCommand(chatId) {
  // Send interactive dashboard via Telegram inline keyboard
  // Update every 500ms with editMessageText
}
```

### Keyboard Implementation
```javascript
// Telegram inline keyboard for console variant
const dashboardKeyboard = {
  inline_keyboard: [
    [
      { text: '🤖 Claude', callback_data: 'agent_claude' },
      { text: '⚡ Groq', callback_data: 'agent_groq' }
    ],
    [
      { text: '🔮 Gemini', callback_data: 'agent_gemini' },
      { text: '🧠 OpenAI', callback_data: 'agent_openai' }
    ],
    [
      { text: '📊 Metrics', callback_data: 'show_metrics' },
      { text: '🔄 Refresh', callback_data: 'refresh_status' }
    ],
    [{ text: '🛑 Close', callback_data: 'close_dashboard' }]
  ]
};
```

---

## Future Enhancements

### Phase 2 Features
1. Historical charts (response time trends)
2. Error breakdown analysis
3. Cost tracking per provider
4. User activity timeline
5. Custom alerts/thresholds

### Phase 3 Features
1. Dark/light mode toggle
2. Custom dashboard layouts
3. Export data (CSV, JSON)
4. Webhook alerts to external systems
5. Multi-user dashboard with permissions

---

## Testing Checklist

- [ ] Desktop view (1920x1080)
- [ ] Tablet view (768x1024)
- [ ] Mobile view (375x667)
- [ ] High contrast mode
- [ ] Keyboard navigation
- [ ] Screen reader (NVDA, JAWS)
- [ ] Real-time updates (500ms refresh)
- [ ] Error states (API down, timeout)
- [ ] Loading states
- [ ] Performance (Lighthouse score > 90)

---

## Conclusion

**Choose Variant B (Cyberpunk Enhanced)** for optimal balance of:
- Visual appeal ✨
- Information clarity 📊
- Development efficiency ⚡
- User satisfaction 👥

Proceed with 20-hour implementation plan detailed above.

