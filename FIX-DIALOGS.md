# Fix Plan: Replace prompt() Dialogs with Custom Modals

## Problem
The dashboard uses native `prompt()` dialogs which:
1. Block browser automation
2. Can't be styled
3. Break in headless browsers

## Root Cause (line 757 of software-house.html)
```javascript
const name = prompt('Nazwa nowego projektu:');
```

## Fix
Replace all `prompt()` calls with custom modal dialogs that:
1. Use HTML/CSS modals (non-blocking)
2. Work in headless browsers
3. Can be styled to match the dashboard theme
4. Are accessible and keyboard-friendly

## Changes Needed

### 1. Add CSS for modal dialogs
### 2. Add HTML for modal template
### 3. Replace prompt() calls with modal.show() pattern
### 4. Add Promise-based API for modal results

## Files to Change
- `dashboard/software-house.html` — main dashboard file
