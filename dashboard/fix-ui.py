#!/usr/bin/env python3
"""Apply scroll/filter/sort to all list/log displays in the dashboard."""
import re, os

HERE = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(HERE, 'index.html')

with open(path) as f:
    html = f.read()

# =========================================================
# 1. CSS additions — utility classes for scrollable lists
# =========================================================
scroll_css = '''
/* Scrollable list containers */
.list-scroll{max-height:320px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius)}
.list-scroll-sm{max-height:200px;overflow-y:auto}
.filter-bar-scroll{margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.filter-bar-scroll input,.filter-bar-scroll select{background:var(--bg-alt);color:var(--text);border:1px solid var(--border);border-radius:var(--radius);padding:4px 8px;font:inherit;font-size:15px}
.filter-bar-scroll input{flex:1;min-width:120px}
.filter-bar-scroll select{min-width:100px}
'''

style_end = html.find('</style>')
html = html[:style_end] + scroll_css + html[style_end:]
print("CSS scroll classes added")

# =========================================================
# 2. Font size overall bump
# =========================================================
# Body: already bumped, skip to avoid breaking CSS

# CSS style block: 11->13, 12->14, 13->15
style_start = html.find('<style>')
style_end = html.find('</style>', style_start)
css = html[style_start+7:style_end]

for old_px, new_px in [('11','13'), ('12','14'), ('13','15')]:
    css = re.sub(rf'font-size:{old_px}(px[ ;}};\n])', lambda m: f'font-size:{new_px}{m.group(1)}', css)
html = html[:style_start+7] + css + html[style_end:]

# Inline/HTML/JS font bumps
before = html[:style_start]
after = html[style_end:]
for old_px, new_px in [('11','13'), ('12','14'), ('13','15')]:
    after = re.sub(rf'font-size:{old_px}(px[ ;}};\n"\'])', lambda m: f'font-size:{new_px}{m.group(1)}', after)
html = before + html[style_start:style_end] + after

# Then bump 14px to 15px inline (outside style block)
after = html[style_end:]
after = after.replace('font-size:14px', 'font-size:15px')
html = html[:style_end] + after
print("Font sizes bumped")

# =========================================================
# 3. Dashboard - Recent Activity: scroll + filter + sort
# =========================================================
old1 = '''      <div class="section-title">\U0001f4cb Recent Activity</div>
      <div class="card">
        <div class="activity">
          ${(logs.entries||[]).slice(0,10).map(e=>`
            <div class="entry">
              <span class="entry-time">${fmtTime(e.ts)}</span>
              <span class="entry-lvl" style="color:${e.level==='error'?'var(--red)':e.level==='warn'?'var(--yellow)':'var(--green)'}">${e.level||'info'}</span>
              <span class="entry-msg">${esc(e.msg||e.message||'')}</span>
            </div>
          `).join('')}
          ${(!logs.entries||!logs.entries.length)?'<div class="empty">No recent activity</div>':''}
        </div>
      </div>'''

new1 = '''      <div class="section-title">\U0001f4cb Recent Activity</div>
      <div class="filter-bar-scroll">
        <select id="dash-log-level" onchange="filterDashLogs()">
          <option value="">All levels</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <select id="dash-log-sort" onchange="filterDashLogs()">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
        <span style="font-size:15px;color:var(--text-dim)">Last 50</span>
      </div>
      <div class="list-scroll" id="dash-activity">
        ${(logs.entries||[]).slice(0,50).map(e=>{
          const lvlCls=e.level==='error'?'var(--red)':e.level==='warn'?'var(--yellow)':'var(--green)';
          return '<div class="entry" data-level="'+(e.level||'info')+'" data-ts="'+(e.ts||'')+'">'+
            '<span class="entry-time">'+fmtTime(e.ts)+'</span>'+
            '<span class="entry-lvl" style="color:'+lvlCls+'">'+(e.level||'info')+'</span>'+
            '<span class="entry-msg">'+esc(e.msg||e.message||'')+'</span></div>';
        }).join('')}
        ${(!logs.entries||!logs.entries.length)?'<div class="empty">No recent activity</div>':''}
      </div>'''

if old1 in html:
    html = html.replace(old1, new1, 1)
    print("Dashboard activity: scroll + filter")
else:
    print("WARNING: Dashboard activity pattern not found")

# =========================================================
# 4. Logs tab: add sort dropdown + scroll
# =========================================================
old2 = '''      <div class="card log-viewer" id="log-entries">
      ${entries.map(e=>{
        const lvl=e.level||'info';
        const color=lvl==='error'?'var(--red)':lvl==='warn'?'var(--yellow)':'var(--text-dim)';
        return `<div class="log-entry" data-level="${lvl}" data-source="${esc(e.source||'')}" data-text="${esc(e.msg||e.message||'').toLowerCase()}">
          <span class="log-time">${fmtTime(e.ts)}</span>
          <span style="color:${color};font-weight:600;width:40px;flex-shrink:0">${lvl}</span>
          <span>[${esc(e.source||'?')}]</span>
          <span>${esc(e.msg||e.message||'')}</span>
        </div>`
      }).join('')}
      ${!entries.length?'<div class="empty">No logs</div>':''}
    </div>'''

new2 = '''      <div class="filter-bar-scroll">
        <select id="log-sort" onchange="filterLogs()">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
        <span style="font-size:15px;color:var(--text-dim)">${ldata.count||entries.length} entries</span>
      </div>
      <div class="list-scroll log-viewer" id="log-entries">
      ${entries.map(e=>{
        const lvl=e.level||'info';
        const color=lvl==='error'?'var(--red)':lvl==='warn'?'var(--yellow)':'var(--text-dim)';
        return `<div class="log-entry" data-level="${lvl}" data-source="${esc(e.source||'')}" data-text="${esc(e.msg||e.message||'').toLowerCase()}" data-ts="${esc(e.ts||'')}">
          <span class="log-time">${fmtTime(e.ts)}</span>
          <span style="color:${color};font-weight:600;width:40px;flex-shrink:0">${lvl}</span>
          <span>[${esc(e.source||'?')}]</span>
          <span>${esc(e.msg||e.message||'')}</span>
        </div>`
      }).join('')}
      ${!entries.length?'<div class="empty">No logs</div>':''}
    </div>'''

if old2 in html:
    html = html.replace(old2, new2, 1)
    print("Logs tab: scroll + sort")
else:
    print("WARNING: Logs viewer pattern not found")

# Update filterLogs function to handle sort
old_fl = '''window.filterLogs=function(){
  const q=($('#log-search')?.value||'').toLowerCase();
  const lvl=$('#log-level-filter')?.value||'';
  const src=$('#log-source-filter')?.value||'';
  document.querySelectorAll('#log-entries .log-entry').forEach(e=>{
    const matchLvl=!lvl||e.getAttribute('data-level')===lvl;
    const matchSrc=!src||e.getAttribute('data-source')===src;
    const matchTxt=!q||e.getAttribute('data-text').includes(q);
    e.style.display=(matchLvl&&matchSrc&&matchTxt)?'':'none';
  });
};'''

new_fl = '''window.filterLogs=function(){
  const q=($('#log-search')?.value||'').toLowerCase();
  const lvl=$('#log-level-filter')?.value||'';
  const src=$('#log-source-filter')?.value||'';
  const sort=$('#log-sort')?.value||'newest';
  const container=$('#log-entries');
  if(!container)return;
  const entries=Array.from(container.querySelectorAll('.log-entry'));
  entries.forEach(e=>{
    const matchLvl=!lvl||e.getAttribute('data-level')===lvl;
    const matchSrc=!src||e.getAttribute('data-source')===src;
    const matchTxt=!q||(e.getAttribute('data-text')||'').includes(q);
    e.style.display=(matchLvl&&matchSrc&&matchTxt)?'':'none';
  });
  if(sort==='oldest'){
    const sorted=entries.sort((a,b)=>(a.getAttribute('data-ts')||'').localeCompare(b.getAttribute('data-ts')||''));
    sorted.forEach(e=>container.appendChild(e));
  }else{
    const sorted=entries.sort((a,b)=>(b.getAttribute('data-ts')||'').localeCompare(a.getAttribute('data-ts')||''));
    sorted.forEach(e=>container.appendChild(e));
  }
};'''

if old_fl in html:
    html = html.replace(old_fl, new_fl, 1)
    print("filterLogs updated with sort")
else:
    print("WARNING: filterLogs not found")

# =========================================================
# 5. Safeguards: scroll + filter + sort
# =========================================================
old3 = '''    <div class="section">
      <div class="section-title">\U0001f4cb Event Log</div>
      <div class="log-viewer" style="max-height:400px;overflow-y:auto">
        ${entries.map(e=>`
          <div class="log-entry">
            <span class="log-time">${fmtTime(e.timestamp)}</span>
            <span class="badge ${e.event==='STUCK'?'badge-red':e.event==='RECOVER'?'badge-green':'badge-yellow'}" style="width:80px">${e.event||'\u2014'}</span>
            <span>${esc(e.details||'')}</span>
          </div>
        `).join('')}
        ${!entries.length?'<div class="empty">No safeguard events</div>':''}
      </div>
    </div>'''

new3 = '''    <div class="section">
      <div class="section-title">\U0001f4cb Event Log</div>
      <div class="filter-bar-scroll">
        <input type="text" id="safeguard-search" placeholder="\U0001f50d Search events\u2026" oninput="filterSafeguards()" style="flex:1;min-width:120px">
        <select id="safeguard-event" onchange="filterSafeguards()">
          <option value="">All events</option>
          <option value="STUCK">STUCK</option>
          <option value="RECOVER">RECOVER</option>
          <option value="WARNING">WARNING</option>
        </select>
        <select id="safeguard-sort" onchange="filterSafeguards()">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>
      <div class="list-scroll log-viewer" id="safeguard-entries">
        ${entries.map(e=>{
          const badgeCls=e.event==='STUCK'?'badge-red':e.event==='RECOVER'?'badge-green':'badge-yellow';
          const safeDetails=esc((e.details||'').toLowerCase());
          return '<div class="log-entry" data-event="'+(e.event||'')+'" data-details="'+safeDetails+'" data-ts="'+(e.timestamp||'')+'">'+
            '<span class="log-time">'+fmtTime(e.timestamp)+'</span>'+
            '<span class="badge '+badgeCls+'" style="width:80px">'+(e.event||'\u2014')+'</span>'+
            '<span>'+esc(e.details||'')+'</span></div>';
        }).join('')}
        ${!entries.length?'<div class="empty">No safeguard events</div>':''}
      </div>
    </div>'''

if old3 in html:
    html = html.replace(old3, new3, 1)
    print("Safeguards: scroll + filter + sort")
else:
    print("WARNING: Safeguards event log not found")

# =========================================================
# 6. Models tab: scroll
# =========================================================
old4 = '''    <div class="table-wrap">
      <table>
        <thead><tr><th>ID</th><th>Provider</th><th>Tier</th><th>Status</th><th>Speed</th><th>Agent Ready</th><th>Verified</th></tr></thead>
        <tbody id="models-tbody">
          ${models.map(m=>`
            <tr class="model-row"'''

new4 = '''    <div class="table-wrap list-scroll" style="max-height:400px">
      <table>
        <thead><tr><th>ID</th><th>Provider</th><th>Tier</th><th>Status</th><th>Speed</th><th>Agent Ready</th><th>Verified</th></tr></thead>
        <tbody id="models-tbody">
          ${models.map(m=>`
            <tr class="model-row"'''

if old4 in html:
    html = html.replace(old4, new4, 1)
    print("Models: scroll added")
else:
    print("WARNING: Models pattern variant - searching...")
    idx = html.find('table-wrap')
    models_idx = html.find('models-tbody')
    if models_idx > -1:
        ctx = html[models_idx-200:models_idx]
        print(f"  Context: {ctx[:100]}")

# =========================================================
# 7. Projects tab: scroll + search
# =========================================================
old5 = '''    <div class="section-title">\U0001f4c1 Projects <span class="badge">${projects.length}</span></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Sessions</th><th>Created</th><th>Free Only</th><th>Routing</th><th></th></tr></thead>
        <tbody>
          ${projects.map(p=>`
            <tr style="cursor:pointer" onclick="showProject('${esc(p.name)}')" title="Click for details">
              <td><strong>${esc(p.name)}</strong></td>'''

new5 = '''    <div class="section-title">\U0001f4c1 Projects <span class="badge">${projects.length}</span></div>
    <div class="filter-bar-scroll">
      <input type="text" id="project-search" placeholder="\U0001f50d Search projects\u2026" oninput="filterProjects()">
      <span style="font-size:15px;color:var(--text-dim)">${projects.length} projects</span>
    </div>
    <div class="table-wrap list-scroll" style="max-height:400px">
      <table>
        <thead><tr><th>Name</th><th>Sessions</th><th>Created</th><th>Free Only</th><th>Routing</th><th></th></tr></thead>
        <tbody id="projects-tbody">
          ${projects.map((p,i)=>{
            const safeName='proj-'+esc(p.name).replace(/[^a-z0-9]/gi,'_');
            return '<tr class="proj-row" data-name="'+esc(p.name).toLowerCase()+'" id="'+safeName+'" style="cursor:pointer" onclick="showProject(\''+esc(p.name)+'\')" title="Click for details">'+
              '<td><strong>'+esc(p.name)+'</strong></td>'''

if old5 in html:
    html = html.replace(old5, new5, 1)
    print("Projects: scroll + search")
else:
    print("WARNING: Projects pattern not found")

# =========================================================
# 8. Project sessions: scroll + filter + sort
# =========================================================
old6 = '''<div class="section">
        <div class="section-title">Sessions <span class="badge">${sessions.length}</span></div>
        <div class="table-wrap" style="max-height:300px;overflow-y:auto">
          <table>
            <thead><tr><th>ID</th><th>Agent</th><th>Model</th><th>Status</th><th>Task</th><th>Start</th><th>Duration</th></tr></thead>
            <tbody>
              ${(()=>{const rev=sessions.slice().reverse();window._projSessions=rev;return rev.map((s,i)=>`
                <tr style="cursor:pointer" onclick="showSessionDetail(window._projSessions[${i}])">
                  <td style="font-size:15px;max-width:90px;overflow:hidden;text-overflow:ellipsis">${esc(s.id||s.session_key||'').slice(0,24)}</td>
                  <td>${esc(s.agent||'\u2014')}</td>
                  <td><span class="tag">${esc(s.model||'\u2014')}</span></td>
                  <td><span class="badge ${s.status==='qa'?'badge-yellow':s.status==='done'?'badge-green':s.status==='failed'?'badge-red':'badge-yellow'}">${s.status||'\u2014'}</span></td>
                  <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;font-size:15px">${esc(s.goal||s.task||'\u2014')}</td>
                  <td style="font-size:15px">${fmtDate(s.start_time)}${(!s.duration||s.duration==='0s'||(s.start_time&&s.end_time&&new Date(s.start_time).getTime()===new Date(s.end_time).getTime()))?' <span style="font-size:15px;color:var(--red)" title="Legacy session \u2014 timestamps unreliable">\u26a0</span>':''}</td>
                  <td>${s.duration&&s.duration!=='0s'?s.duration:'\u2014'}</td>
                </tr>
              `).join('')})()}
              ${!sessions.length?'<tr><td colspan="7" class="empty">No sessions</td></tr>':''}
            </tbody>
          </table>
        </div>
      </div>'''

new6 = '''<div class="section">
        <div class="section-title">Sessions <span class="badge">${sessions.length}</span></div>
        <div class="filter-bar-scroll">
          <input type="text" id="proj-session-search" placeholder="\U0001f50d Search sessions\u2026" oninput="filterProjSessions()">
          <select id="proj-session-status" onchange="filterProjSessions()">
            <option value="">All statuses</option>
            <option value="done">done</option>
            <option value="running">running</option>
            <option value="failed">failed</option>
            <option value="qa">qa</option>
          </select>
          <select id="proj-session-sort" onchange="filterProjSessions()">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </div>
        <div class="table-wrap list-scroll" style="max-height:350px" id="proj-sessions-table">
          <table>
            <thead><tr><th>ID</th><th>Agent</th><th>Model</th><th>Status</th><th>Task</th><th>Start</th><th>Duration</th></tr></thead>
            <tbody>
              ${(()=>{const rev=sessions.slice().reverse();window._projSessions=rev;return rev.map((s,i)=>`
                <tr class="sess-row" style="cursor:pointer" onclick="showSessionDetail(window._projSessions[${i}])" data-status="${s.status||''}" data-task="${esc(s.goal||s.task||'').toLowerCase()}">
                  <td style="font-size:15px;max-width:90px;overflow:hidden;text-overflow:ellipsis">${esc(s.id||s.session_key||'').slice(0,24)}</td>
                  <td>${esc(s.agent||'\u2014')}</td>
                  <td><span class="tag">${esc(s.model||'\u2014')}</span></td>
                  <td><span class="badge ${s.status==='qa'?'badge-yellow':s.status==='done'?'badge-green':s.status==='failed'?'badge-red':'badge-yellow'}">${s.status||'\u2014'}</span></td>
                  <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;font-size:15px">${esc(s.goal||s.task||'\u2014')}</td>
                  <td style="font-size:15px">${fmtDate(s.start_time)}${(!s.duration||s.duration==='0s'||(s.start_time&&s.end_time&&new Date(s.start_time).getTime()===new Date(s.end_time).getTime()))?' <span style="font-size:15px;color:var(--red)" title="Legacy session \u2014 timestamps unreliable">\u26a0</span>':''}</td>
                  <td>${s.duration&&s.duration!=='0s'?s.duration:'\u2014'}</td>
                </tr>
              `).join('')})()}
              ${!sessions.length?'<tr><td colspan="7" class="empty">No sessions</td></tr>':''}
            </tbody>
          </table>
        </div>
      </div>'''

if old6 in html:
    html = html.replace(old6, new6, 1)
    print("Project sessions: scroll + filter + sort")
else:
    print("WARNING: Project sessions pattern not found")

# =========================================================
# 9. SSE viewer: add scroll
# =========================================================
html = html.replace(
    '<div class="log-viewer" id="sse-output" style="margin-top:6px">',
    '<div class="log-viewer list-scroll" id="sse-output" style="margin-top:6px">'
)
print("SSE viewer: scroll added")

# =========================================================
# 10. Add all the filter/misc JS functions
# =========================================================

# filterDashLogs
dash_fn = """window.filterDashLogs=function(){
  const lvl=$('#dash-log-level')?.value||'';
  const sort=$('#dash-log-sort')?.value||'newest';
  const container=$('#dash-activity');
  if(!container)return;
  const entries=Array.from(container.querySelectorAll('.entry'));
  entries.forEach(e=>{
    const elvl=e.getAttribute('data-level')||'';
    e.style.display=(!lvl||elvl===lvl)?'':'none';
  });
  if(sort==='oldest'){
    const sorted=entries.sort((a,b)=>(a.getAttribute('data-ts')||'').localeCompare(b.getAttribute('data-ts')||''));
    sorted.forEach(e=>container.appendChild(e));
  }else{
    const sorted=entries.sort((a,b)=>(b.getAttribute('data-ts')||'').localeCompare(a.getAttribute('data-ts')||''));
    sorted.forEach(e=>container.appendChild(e));
  }
};

"""

# filterSafeguards
saf_fn = """window.filterSafeguards=function(){
  const q=($('#safeguard-search')?.value||'').toLowerCase();
  const evt=$('#safeguard-event')?.value||'';
  const sort=$('#safeguard-sort')?.value||'newest';
  const container=$('#safeguard-entries');
  if(!container)return;
  const entries=Array.from(container.querySelectorAll('.log-entry'));
  entries.forEach(e=>{
    const matchEvt=!evt||e.getAttribute('data-event')===evt;
    const matchTxt=!q||(e.getAttribute('data-details')||'').includes(q);
    e.style.display=(matchEvt&&matchTxt)?'':'none';
  });
  if(sort==='oldest'){
    const sorted=entries.sort((a,b)=>(a.getAttribute('data-ts')||'').localeCompare(b.getAttribute('data-ts')||''));
    sorted.forEach(e=>container.appendChild(e));
  }else{
    const sorted=entries.sort((a,b)=>(b.getAttribute('data-ts')||'').localeCompare(a.getAttribute('data-ts')||''));
    sorted.forEach(e=>container.appendChild(e));
  }
};

"""

# filterProjects
proj_fn = """window.filterProjects=function(){
  const q=($('#project-search')?.value||'').toLowerCase();
  document.querySelectorAll('#projects-tbody .proj-row').forEach(e=>{
    const name=e.getAttribute('data-name')||'';
    e.style.display=name.includes(q)?'':'none';
  });
};

"""

# filterProjSessions
ps_fn = """window.filterProjSessions=function(){
  const searchId='proj-session-search';
  const q=($('#'+searchId)?.value||'').toLowerCase();
  const st=$('#proj-session-status')?.value||'';
  const sort=$('#proj-session-sort')?.value||'newest';
  const tbody=$('#proj-sessions-table tbody');
  if(!tbody)return;
  const entries=Array.from(tbody.querySelectorAll('.sess-row'));
  entries.forEach(e=>{
    const matchSt=!st||e.getAttribute('data-status')===st;
    const matchTxt=!q||(e.getAttribute('data-task')||'').includes(q);
    e.style.display=(matchSt&&matchTxt)?'':'none';
  });
  if(sort==='oldest'){
    tbody.innerHTML='';
    entries.reverse().forEach(e=>tbody.appendChild(e));
  }
};

"""

# Insert functions after the existing filterLogs
insert_marker = 'window.filterLogs=function'
idx = html.find(insert_marker)
if idx > -1:
    end_idx = html.find('};', html.find('};', idx) + 2) + 2
    html = html[:end_idx] + '\n' + dash_fn + saf_fn + proj_fn + ps_fn + html[end_idx:]
    print("Filter JS functions added")
else:
    print("WARNING: Could not insert JS functions")

# =========================================================
# Verify
# =========================================================
checks = [
    ('filterDashLogs', 'window.filterDashLogs' in html),
    ('filterLogs sort', 'log-sort' in html and 'window.filterLogs' in html),
    ('filterSafeguards', 'window.filterSafeguards' in html),
    ('filterProjects', 'window.filterProjects' in html),
    ('filterProjSessions', 'window.filterProjSessions' in html),
    ('list-scroll CSS', '.list-scroll{' in html),
    ('filter-bar-scroll CSS', '.filter-bar-scroll{' in html),
    ('dash-activity scroll', 'list-scroll' in html[html.find('dash-activity'):html.find('dash-activity')+50]),
    ('log sort dropdown', 'id="log-sort"' in html),
    ('safeguard search', 'id="safeguard-search"' in html),
    ('project search', 'id="project-search"' in html),
    ('proj session filter', 'id="proj-session-search"' in html),
    ('models list-scroll', 'list-scroll' in html[html.find('models-tbody')-50:html.find('models-tbody')]),
    ('projects list-scroll', 'list-scroll' in html[html.find('projects-tbody')-50:html.find('projects-tbody')]),
    ('sse list-scroll', 'list-scroll' in html[html.find('sse-output'):html.find('sse-output')+50]),
]

print("\n=== Verification ===")
for name, ok in checks:
    print(f"  {'OK' if ok else 'FAIL'} {name}")

if not all(ok for _, ok in checks):
    print("\nWARNING: Some checks failed!")
else:
    print("\nAll checks passed!")

with open(path, 'w') as f:
    f.write(html)

print(f"\nDone! ({len(html)} bytes)")
