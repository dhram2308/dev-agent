"use strict";

const { STAGES } = require("../lib/constants");

/**
 * Returns the HTML template for the Web UI.
 * @param {string} apiToken - The API token to inject into the client-side JS
 * @returns {string} Full HTML document
 */
function getHTML(apiToken) {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Dev Agent</title>
<style>
  :root {
    --bg: #0f1117;
    --bg2: #1a1d27;
    --bg3: #242736;
    --border: #2e3245;
    --text: #e4e6f0;
    --text2: #9499b3;
    --text3: #5c6180;
    --blue: #4c8dff;
    --blue-bg: #1a2744;
    --green: #4ade80;
    --green-bg: #132e23;
    --red: #f87171;
    --red-bg: #2d1a1a;
    --yellow: #facc15;
    --yellow-bg: #2d2714;
    --purple: #a78bfa;
    --purple-bg: #231e3d;
    --mono: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font-family: var(--sans); min-height: 100vh; }

  .container { max-width: 1100px; margin: 0 auto; padding: 24px 20px; }

  /* Header */
  .header { display: flex; align-items: center; gap: 16px; margin-bottom: 28px; }
  .header-icon { font-size: 32px; }
  .header h1 { font-size: 22px; font-weight: 600; }
  .header p { font-size: 13px; color: var(--text2); margin-top: 2px; }
  .header-status {
    margin-left: auto; padding: 6px 16px; border-radius: 20px;
    font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
  }
  .header-status.idle { background: var(--bg3); color: var(--text3); }
  .header-status.running { background: var(--green-bg); color: var(--green); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }

  /* Input bar */
  .input-bar {
    display: flex; gap: 10px; margin-bottom: 28px;
    background: var(--bg2); border: 1px solid var(--border); border-radius: 12px;
    padding: 12px 16px; align-items: center;
  }
  .input-bar label { font-size: 13px; color: var(--text2); white-space: nowrap; }
  .input-bar input {
    flex: 1; background: var(--bg3); border: 1px solid var(--border); border-radius: 8px;
    padding: 10px 14px; color: var(--text); font-family: var(--mono); font-size: 14px;
    outline: none; transition: border 0.2s;
  }
  .input-bar input:focus { border-color: var(--blue); }
  .btn {
    padding: 10px 22px; border-radius: 8px; font-size: 13px; font-weight: 600;
    cursor: pointer; border: none; transition: all 0.2s; white-space: nowrap;
  }
  .btn-start { background: var(--blue); color: #fff; }
  .btn-start:hover { background: #3a7ae8; }
  .btn-start:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-stop { background: var(--red-bg); color: var(--red); border: 1px solid #5a2020; }
  .btn-stop:hover { background: #3a1f1f; }
  .btn-reset { background: var(--bg3); color: var(--text2); border: 1px solid var(--border); }
  .btn-reset:hover { color: var(--text); }

  /* Steps */
  .steps-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(74px, 1fr));
    gap: 8px; margin-bottom: 24px;
  }
  .step-pill {
    display: flex; flex-direction: column; align-items: center; gap: 4px;
    padding: 10px 6px; border-radius: 10px; cursor: pointer;
    border: 1.5px solid var(--border); background: var(--bg2);
    transition: all 0.2s; font-size: 11px; text-align: center;
    font-family: var(--sans); color: var(--text);
  }
  .step-pill:hover { border-color: var(--text3); }
  .step-pill .icon { font-size: 18px; }
  .step-pill .num { font-weight: 600; color: var(--text2); }
  .step-pill.active { border-color: var(--blue); background: var(--blue-bg); }
  .step-pill.active .num { color: var(--blue); }
  .step-pill.done { border-color: var(--green); background: var(--green-bg); }
  .step-pill.done .num { color: var(--green); }
  .step-pill.current { border-color: var(--yellow); background: var(--yellow-bg); animation: pulse 2s infinite; }
  .step-pill.current .num { color: var(--yellow); }
  .step-pill.failed { border-color: var(--red); background: var(--red-bg); }
  .step-pill.failed .num { color: var(--red); }

  /* Detail card */
  .detail-card {
    border-radius: 12px; border: 1.5px solid var(--border); background: var(--bg2);
    padding: 20px 24px; margin-bottom: 24px;
  }
  .detail-card .step-header {
    display: flex; align-items: center; gap: 12px; margin-bottom: 14px;
  }
  .detail-card .step-icon { font-size: 28px; }
  .detail-card .step-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
  .detail-card .step-title { font-size: 16px; font-weight: 600; }
  .who-badge {
    margin-left: auto; padding: 4px 14px; border-radius: 20px;
    font-size: 11px; font-weight: 600; border: 1px solid;
  }
  .who-you { color: var(--red); border-color: #5a2020; background: var(--red-bg); }
  .who-agent { color: var(--green); border-color: #1a4a2e; background: var(--green-bg); }
  .who-both { color: var(--purple); border-color: #3a2860; background: var(--purple-bg); }
  .detail-what {
    font-family: var(--mono); font-size: 13px; padding: 8px 12px;
    background: var(--bg3); border-radius: 8px; margin-bottom: 12px;
    color: var(--blue);
  }
  .detail-text { font-size: 13px; color: var(--text2); line-height: 1.7; }
  .detail-action {
    margin-top: 14px; padding: 10px 14px; border-radius: 8px;
    background: var(--red-bg); border: 1px solid #5a2020;
    font-size: 13px; font-weight: 500; color: var(--red);
  }

  /* Log terminal */
  .log-section { margin-bottom: 24px; }
  .log-header {
    display: flex; align-items: center; gap: 10px; margin-bottom: 10px;
  }
  .log-header h3 { font-size: 14px; font-weight: 600; }
  .log-count {
    font-size: 11px; color: var(--text3); background: var(--bg3);
    padding: 2px 10px; border-radius: 10px;
  }
  .log-terminal {
    background: #0a0c10; border: 1px solid var(--border); border-radius: 10px;
    padding: 16px; height: 360px; overflow-y: auto; font-family: var(--mono);
    font-size: 12px; line-height: 1.7;
  }
  .log-terminal::-webkit-scrollbar { width: 6px; }
  .log-terminal::-webkit-scrollbar-thumb { background: var(--bg3); border-radius: 3px; }
  .log-line { white-space: pre-wrap; word-break: break-all; }
  .log-line.stdout { color: var(--text); }
  .log-line.stderr { color: var(--red); }
  .log-line.system { color: var(--yellow); font-style: italic; }

  /* Nav buttons */
  .nav { display: flex; gap: 10px; align-items: center; }
  .nav .counter { margin-left: auto; font-size: 12px; color: var(--text3); }

  /* Summary table */
  .summary { margin-top: 28px; border-top: 1px solid var(--border); padding-top: 20px; }
  .summary h3 { font-size: 13px; font-weight: 600; color: var(--text2); margin-bottom: 12px; }
  .summary-row {
    display: flex; gap: 10px; align-items: center; padding: 8px 10px;
    border-bottom: 1px solid #1a1d27; border-radius: 6px; cursor: pointer;
    transition: background 0.15s;
  }
  .summary-row:hover { background: var(--bg2); }
  .summary-row .s-icon { font-size: 14px; min-width: 22px; }
  .summary-row .s-title { flex: 1; font-size: 12px; }
  .summary-row .s-status {
    font-size: 10px; font-weight: 600; padding: 2px 10px; border-radius: 10px;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .s-pending { background: var(--bg3); color: var(--text3); }
  .s-done { background: var(--green-bg); color: var(--green); }
  .s-active { background: var(--yellow-bg); color: var(--yellow); }

  /* Review panel */
  #reviewPanel {
    border-radius: 12px; border: 1.5px solid var(--border); background: var(--bg2);
    padding: 20px 24px; margin-bottom: 24px; display: none;
  }
  #reviewPanel.visible { display: block; }
  .review-title {
    font-size: 15px; font-weight: 600; margin-bottom: 14px;
    display: flex; align-items: center; gap: 10px;
  }
  .review-title .gate-badge {
    font-size: 11px; padding: 3px 10px; border-radius: 10px;
    background: var(--yellow-bg); color: var(--yellow); font-weight: 600;
  }

  /* Plan viewer — tabbed layout */
  #planViewer {
    display: none;
  }
  #planViewer.visible { display: block; }

  .plan-tabs {
    display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 2px solid var(--border);
    padding-bottom: 0;
  }
  .plan-tab {
    padding: 8px 18px; border-radius: 8px 8px 0 0; font-size: 12px; font-weight: 600;
    cursor: pointer; border: 1px solid transparent; border-bottom: none;
    background: transparent; color: var(--text3); transition: all 0.15s;
    font-family: var(--sans);
  }
  .plan-tab:hover { color: var(--text); background: var(--bg3); }
  .plan-tab.active {
    background: var(--bg3); color: var(--blue); border-color: var(--border);
    border-bottom: 2px solid var(--bg3); margin-bottom: -2px;
  }
  .plan-tab-content {
    background: var(--bg3); border-radius: 0 8px 8px 8px; padding: 16px;
    font-family: var(--mono); font-size: 12px; line-height: 1.8;
    max-height: 500px; overflow-y: auto; white-space: pre-wrap; word-break: break-word;
    color: var(--text2);
  }

  /* Plan summary overview */
  .plan-summary {
    margin-bottom: 14px; padding: 12px 16px; border-radius: 8px;
    background: var(--bg3); border: 1px solid var(--border);
  }
  .plan-summary-title {
    font-size: 13px; font-weight: 700; color: var(--text); margin-bottom: 8px;
    font-family: var(--sans);
  }
  .plan-summary-stats {
    display: flex; gap: 12px; flex-wrap: wrap;
  }
  .plan-stat {
    display: flex; align-items: center; gap: 6px; font-size: 11px; font-family: var(--sans);
    color: var(--text2); background: var(--bg); padding: 4px 10px; border-radius: 6px;
    border: 1px solid var(--border);
  }
  .plan-stat-num {
    font-weight: 700; color: var(--blue); font-size: 13px;
  }

  /* Plan suggestions */
  .plan-suggestions {
    margin-top: 12px; padding: 12px 16px; border-radius: 8px;
    background: var(--yellow-bg); border: 1px solid #5a4a10;
  }
  .plan-suggestions .sug-title {
    font-size: 12px; font-weight: 700; color: var(--yellow); margin-bottom: 8px;
    display: flex; align-items: center; gap: 6px;
  }
  .plan-suggestions .sug-item {
    font-size: 12px; color: var(--text2); padding: 3px 0 3px 16px;
    position: relative; line-height: 1.5;
  }
  .plan-suggestions .sug-item::before {
    content: "\\2022"; position: absolute; left: 4px; color: var(--yellow);
  }

  /* Refine button and form */
  .btn-refine {
    padding: 10px 28px; border-radius: 8px; font-size: 13px; font-weight: 600;
    cursor: pointer; background: transparent; color: var(--purple);
    border: 1.5px solid var(--purple); transition: all 0.2s;
  }
  .btn-refine:hover { background: var(--purple-bg); }
  .btn-refine:disabled { opacity: 0.4; cursor: not-allowed; }
  #refineFeedback {
    display: none; margin-top: 12px;
  }
  #refineFeedback.visible { display: block; }
  #refineFeedback textarea {
    width: 100%; height: 80px; background: var(--bg3); border: 1px solid var(--border);
    border-radius: 8px; padding: 10px; color: var(--text); font-family: var(--mono);
    font-size: 12px; resize: vertical; outline: none;
  }
  #refineFeedback textarea:focus { border-color: var(--purple); }
  #refineFeedback button {
    margin-top: 8px; padding: 8px 20px; border-radius: 8px; font-size: 12px;
    font-weight: 600; cursor: pointer; border: none;
    background: var(--purple); color: #fff;
  }

  /* Diff file tabs */
  #diffViewer { display: none; }
  #diffViewer.visible { display: block; }
  .diff-file-tabs {
    display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px;
  }
  .diff-file-tab {
    padding: 6px 14px; border-radius: 8px; font-size: 12px; font-family: var(--mono);
    cursor: pointer; border: 1px solid var(--border); background: var(--bg3);
    color: var(--text2); transition: all 0.15s; display: flex; align-items: center; gap: 6px;
  }
  .diff-file-tab:hover { border-color: var(--text3); color: var(--text); }
  .diff-file-tab.active { border-color: var(--blue); color: var(--blue); background: var(--blue-bg); }
  .action-badge {
    font-size: 9px; font-weight: 700; padding: 1px 6px; border-radius: 4px;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .action-badge.create { background: var(--green-bg); color: var(--green); }
  .action-badge.update { background: var(--blue-bg); color: var(--blue); }
  .action-badge.delete { background: var(--red-bg); color: var(--red); }

  /* Diff table */
  .diff-table-wrap {
    border: 1px solid var(--border); border-radius: 8px; overflow: auto;
    max-height: 500px;
  }
  .diff-table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12px; }
  .diff-table td { padding: 0 10px; line-height: 1.7; }
  .diff-table td.line-content { overflow-x: auto; white-space: pre; }
  .diff-table .line-num {
    width: 50px; min-width: 50px; text-align: right; color: var(--text3);
    user-select: none; padding-right: 8px; border-right: 1px solid var(--border);
    position: sticky; left: 0; background: inherit; z-index: 1;
  }
  .diff-table .line-prefix { width: 16px; min-width: 16px; text-align: center; user-select: none; }
  .diff-line-add { background: rgba(52,211,153,0.08); }
  .diff-line-add td { color: var(--green); }
  .diff-line-add .line-prefix { color: var(--green); }
  .diff-line-del { background: rgba(248,113,113,0.08); }
  .diff-line-del td { color: var(--red); }
  .diff-line-del .line-prefix { color: var(--red); }
  .diff-line-ctx td.line-content { color: var(--text3); }
  .diff-line-ctx .line-prefix { color: var(--text3); }

  /* Diff toolbar — Unified/Split toggle */
  .diff-toolbar {
    display: flex; align-items: center; gap: 12px; margin-bottom: 10px;
  }
  .diff-mode-toggle {
    display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden;
  }
  .diff-mode-btn {
    padding: 5px 16px; font-size: 12px; font-weight: 600; cursor: pointer;
    background: var(--bg3); color: var(--text3); border: none; transition: all 0.15s;
  }
  .diff-mode-btn:not(:last-child) { border-right: 1px solid var(--border); }
  .diff-mode-btn.active { background: var(--blue-bg); color: var(--blue); }
  .diff-mode-btn:hover:not(.active) { color: var(--text); }

  /* Split-mode diff table */
  .diff-table.split-mode { table-layout: fixed; }
  .diff-table.split-mode td.line-content-split { width: 45%; overflow-x: auto; white-space: pre; padding: 0 10px; line-height: 1.7; }
  .diff-table.split-mode td.split-gutter {
    width: 2px; min-width: 2px; max-width: 2px; padding: 0;
    background: var(--border);
  }
  .diff-table.split-mode td.line-num { width: 42px; min-width: 42px; }
  .split-line-add { background: rgba(52,211,153,0.08); }
  .split-line-add td { color: var(--green); }
  .split-line-del { background: rgba(248,113,113,0.08); }
  .split-line-del td { color: var(--red); }
  .split-line-empty td { color: var(--text3); }
  .split-line-ctx td.line-content-split { color: var(--text3); }

  /* Character-level diff highlights */
  .char-add { background: rgba(52,211,153,0.25); border-radius: 2px; padding: 0 1px; }
  .char-del { background: rgba(248,113,113,0.25); border-radius: 2px; padding: 0 1px; }

  /* Comment trigger (+ icon column) */
  .comment-trigger {
    width: 20px; min-width: 20px; text-align: center; cursor: pointer;
    color: var(--blue); opacity: 0; transition: opacity 0.15s; user-select: none;
    font-size: 14px; font-weight: 700;
  }
  .diff-table tr:hover .comment-trigger { opacity: 1; }
  .comment-trigger:hover { opacity: 1 !important; color: var(--cyan); }

  /* Inline comment form row */
  .inline-comment-row td { padding: 8px 10px !important; background: var(--bg); }
  .inline-comment-form {
    display: flex; flex-direction: column; gap: 6px;
  }
  .inline-comment-form textarea {
    width: 100%; height: 60px; background: var(--bg3); border: 1px solid var(--border);
    border-radius: 6px; padding: 8px; color: var(--text); font-family: var(--mono);
    font-size: 12px; resize: vertical; outline: none;
  }
  .inline-comment-form textarea:focus { border-color: var(--blue); }
  .inline-comment-form .comment-btns { display: flex; gap: 6px; }
  .inline-comment-form .comment-btns button {
    padding: 4px 14px; border-radius: 6px; font-size: 11px; font-weight: 600;
    cursor: pointer; border: none;
  }
  .inline-comment-form .comment-btns .btn-add-comment { background: var(--blue); color: #fff; }
  .inline-comment-form .comment-btns .btn-cancel-comment { background: var(--bg3); color: var(--text3); border: 1px solid var(--border); }

  /* Saved inline comment display */
  .inline-comment-display {
    margin: 4px 0; padding: 6px 10px; border-left: 3px solid var(--blue);
    background: var(--bg); border-radius: 0 6px 6px 0; font-size: 12px;
    color: var(--text2); line-height: 1.5;
  }
  .inline-comment-display .comment-time {
    font-size: 10px; color: var(--text3); margin-left: 8px;
  }

  /* Comment count badge on file tabs */
  .comment-count-badge {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
    background: var(--blue); color: #fff; font-size: 10px; font-weight: 700;
  }

  /* QA viewer */
  #qaViewer { display: none; }
  #qaViewer.visible { display: block; }
  .qa-row {
    display: flex; align-items: center; gap: 10px; padding: 8px 12px;
    border-bottom: 1px solid var(--border); font-size: 13px;
  }
  .qa-row:last-child { border-bottom: none; }
  .qa-badge {
    font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 6px;
    text-transform: uppercase;
  }
  .qa-badge.pass { background: var(--green-bg); color: var(--green); }
  .qa-badge.fail { background: var(--red-bg); color: var(--red); }
  .qa-badge.inconclusive { background: var(--yellow-bg); color: var(--yellow); }

  /* 9.1: Runtime test results panel */
  #testResultsPanel { display: none; margin-top: 12px; }
  #testResultsPanel.visible { display: block; }
  .test-results-card {
    background: var(--card); border: 1px solid var(--border); border-radius: 10px;
    padding: 14px; margin-bottom: 8px;
  }
  .test-results-title { font-size: 13px; font-weight: 700; color: var(--text1); margin-bottom: 8px; }
  .test-result-row {
    display: flex; align-items: center; gap: 10px; padding: 6px 0;
    border-bottom: 1px solid var(--border); font-size: 12px;
  }
  .test-result-row:last-child { border-bottom: none; }
  .test-badge {
    font-size: 9px; font-weight: 700; padding: 2px 7px; border-radius: 5px;
    text-transform: uppercase; white-space: nowrap;
  }
  .test-badge.pass { background: var(--green-bg); color: var(--green); }
  .test-badge.fail { background: var(--red-bg); color: var(--red); }
  .test-badge.inconclusive { background: var(--yellow-bg); color: var(--yellow); }
  .test-badge.skipped { background: var(--bg2); color: var(--text3); }

  /* MR viewer */
  #mrViewer { display: none; }
  #mrViewer.visible { display: block; }
  .mr-link {
    display: inline-block; padding: 8px 16px; border-radius: 8px;
    background: var(--blue-bg); color: var(--blue); text-decoration: none;
    font-size: 13px; font-weight: 600; margin-bottom: 12px;
  }
  .mr-link:hover { background: #1f3058; }
  .mr-summary { font-size: 13px; color: var(--text2); line-height: 1.7; }

  /* Review actions */
  .review-actions {
    display: flex; gap: 10px; margin-top: 16px; padding-top: 16px;
    border-top: 1px solid var(--border); align-items: center;
  }
  .btn-approve {
    padding: 10px 28px; border-radius: 8px; font-size: 13px; font-weight: 600;
    cursor: pointer; border: none; background: var(--green); color: #0f1117;
    transition: all 0.2s;
  }
  .btn-approve:hover { background: #2bc48a; }
  .btn-approve:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-reject {
    padding: 10px 28px; border-radius: 8px; font-size: 13px; font-weight: 600;
    cursor: pointer; background: transparent; color: var(--red);
    border: 1.5px solid var(--red); transition: all 0.2s;
  }
  .btn-reject:hover { background: var(--red-bg); }
  .btn-reject:disabled { opacity: 0.4; cursor: not-allowed; }
  .review-status {
    margin-left: auto; font-size: 12px; font-weight: 600;
  }

  /* Reject feedback */
  #rejectFeedback {
    display: none; margin-top: 12px;
  }
  #rejectFeedback.visible { display: block; }
  #rejectFeedback textarea {
    width: 100%; height: 80px; background: var(--bg3); border: 1px solid var(--border);
    border-radius: 8px; padding: 10px; color: var(--text); font-family: var(--mono);
    font-size: 12px; resize: vertical; outline: none;
  }
  #rejectFeedback textarea:focus { border-color: var(--red); }
  #rejectFeedback button {
    margin-top: 8px; padding: 8px 20px; border-radius: 8px; font-size: 12px;
    font-weight: 600; cursor: pointer; border: none;
    background: var(--red); color: #fff;
  }

  /* Y15: Focus outline restoration — :focus-visible for keyboard nav */
  *:focus { outline: none; }
  *:focus-visible {
    outline: 2px solid var(--blue);
    outline-offset: 2px;
    border-radius: 4px;
  }

  /* Y17: RTL text direction fix for diff cells */
  .diff-table td.line-content,
  .diff-table td.line-content-split {
    direction: ltr;
    unicode-bidi: plaintext;
  }

  /* U6: File search/filter above diff tabs */
  .diff-file-search {
    display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
  }
  .diff-file-search input {
    flex: 1; max-width: 320px; padding: 6px 12px; background: var(--bg3);
    border: 1px solid var(--border); border-radius: 8px; color: var(--text);
    font-family: var(--mono); font-size: 12px; outline: none;
  }
  .diff-file-search input:focus { border-color: var(--blue); }
  .diff-file-search .match-count {
    font-size: 11px; color: var(--text3);
  }

  /* U7: Files changed summary stats */
  .diff-stats {
    display: flex; gap: 14px; margin-bottom: 10px; font-size: 12px;
    font-family: var(--mono); color: var(--text2);
  }
  .diff-stats .stat-added { color: var(--green); }
  .diff-stats .stat-modified { color: var(--blue); }
  .diff-stats .stat-deleted { color: var(--red); }
  .diff-stats .stat-lines { color: var(--text3); }

  /* U2: Collapsed unchanged lines */
  .diff-collapse-row td {
    text-align: center; padding: 4px 10px !important;
    color: var(--text3); font-style: italic; font-size: 11px;
    background: var(--bg); cursor: pointer;
  }
  .diff-collapse-row:hover td { color: var(--text2); background: var(--bg2); }

  /* Y12: New/Deleted file labels */
  .diff-file-label {
    display: inline-block; padding: 4px 12px; border-radius: 6px;
    font-size: 11px; font-weight: 600; margin-bottom: 8px;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .diff-file-label.new-file { background: var(--green-bg); color: var(--green); }
  .diff-file-label.deleted-file { background: var(--red-bg); color: var(--red); }

  /* O5: Error/warning banners */
  .banner-error {
    padding: 12px 16px; border-radius: 8px; margin-bottom: 16px;
    background: var(--red-bg); border: 1px solid #5a2020;
    color: var(--red); font-size: 13px; font-weight: 500;
  }
  .banner-warning {
    padding: 12px 16px; border-radius: 8px; margin-bottom: 16px;
    background: var(--yellow-bg); border: 1px solid #5a4a10;
    color: var(--yellow); font-size: 13px; font-weight: 500;
  }
  .banner-warning ul { margin: 6px 0 0 18px; font-size: 12px; }

  /* O13: Approval status display */
  .approval-status {
    font-size: 12px; color: var(--text2); margin-top: 8px;
  }
  .approval-status .approved { color: var(--green); font-weight: 600; }
  .approval-status .pending { color: var(--yellow); font-weight: 600; }

  /* Y10: Connection-lost banner */
  .connection-lost-banner {
    display: none; padding: 10px 16px; border-radius: 8px; margin-bottom: 16px;
    background: var(--red-bg); border: 1px solid #5a2020;
    color: var(--red); font-size: 13px; font-weight: 500; text-align: center;
  }
  .connection-lost-banner.visible { display: block; }

  /* O2: Stuck detection banner */
  .banner-stuck {
    padding: 12px 16px; border-radius: 8px; margin-bottom: 16px;
    background: var(--yellow-bg); border: 1px solid #5a4a10;
    color: var(--yellow); font-size: 13px; font-weight: 600;
    display: flex; align-items: center; gap: 10px;
  }
  .banner-stuck.severe {
    background: var(--red-bg); border-color: #5a2020;
    color: var(--red);
  }
  .banner-stuck .stuck-icon { font-size: 18px; }

  /* O9: Context injection panel */
  .context-inject-panel {
    border-radius: 12px; border: 1.5px solid var(--border); background: var(--bg2);
    padding: 16px 20px; margin-bottom: 24px;
  }
  .context-inject-panel h4 {
    font-size: 13px; font-weight: 600; color: var(--text2); margin-bottom: 10px;
    display: flex; align-items: center; gap: 8px;
  }
  .context-inject-panel textarea {
    width: 100%; height: 80px; background: var(--bg3); border: 1px solid var(--border);
    border-radius: 8px; padding: 10px; color: var(--text); font-family: var(--mono);
    font-size: 12px; resize: vertical; outline: none;
  }
  .context-inject-panel textarea:focus { border-color: var(--blue); }
  .context-inject-panel .inject-actions {
    display: flex; gap: 10px; margin-top: 10px; align-items: center;
  }
  .btn-inject {
    padding: 8px 20px; border-radius: 8px; font-size: 12px; font-weight: 600;
    cursor: pointer; border: none; background: var(--purple); color: #fff;
    transition: all 0.2s;
  }
  .btn-inject:hover { background: #9070e8; }
  .btn-inject:disabled { opacity: 0.4; cursor: not-allowed; }
  .inject-status { font-size: 11px; color: var(--text3); }

  /* O4: Log viewer panel */
  .log-viewer-panel {
    border-radius: 12px; border: 1.5px solid var(--border); background: var(--bg2);
    padding: 16px 20px; margin-bottom: 24px;
  }
  .log-viewer-header {
    display: flex; align-items: center; gap: 10px; cursor: pointer;
    margin-bottom: 0; transition: margin 0.2s;
  }
  .log-viewer-header.expanded { margin-bottom: 12px; }
  .log-viewer-header h4 {
    font-size: 13px; font-weight: 600; color: var(--text2);
    display: flex; align-items: center; gap: 8px;
  }
  .log-viewer-header .toggle-icon {
    font-size: 12px; color: var(--text3); transition: transform 0.2s;
  }
  .log-viewer-header .toggle-icon.open { transform: rotate(90deg); }
  .log-viewer-header .log-total {
    margin-left: auto; font-size: 11px; color: var(--text3);
    background: var(--bg3); padding: 2px 10px; border-radius: 10px;
  }
  .log-viewer-content {
    display: none; background: #0a0c10; border: 1px solid var(--border);
    border-radius: 8px; padding: 12px; max-height: 300px; overflow-y: auto;
    font-family: var(--mono); font-size: 11px; line-height: 1.6;
  }
  .log-viewer-content.visible { display: block; }
  .log-viewer-content .log-file-line {
    white-space: pre-wrap; word-break: break-all; color: var(--text2);
    padding: 1px 0;
  }

  /* U10: Binary file placeholder */
  .binary-placeholder {
    padding: 24px; text-align: center; color: var(--text3);
    font-family: var(--mono); font-size: 13px;
  }

  /* U8: Rejection preview modal */
  .reject-modal-overlay {
    display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.6); z-index: 1000; align-items: center; justify-content: center;
  }
  .reject-modal-overlay.visible { display: flex; }
  .reject-modal {
    background: var(--bg2); border: 1.5px solid var(--border); border-radius: 12px;
    padding: 24px; max-width: 600px; width: 90%; max-height: 80vh; overflow-y: auto;
  }
  .reject-modal h3 { font-size: 15px; font-weight: 600; margin-bottom: 14px; color: var(--red); }
  .reject-modal .preview-section { margin-bottom: 14px; }
  .reject-modal .preview-section h4 {
    font-size: 12px; font-weight: 600; color: var(--text2); margin-bottom: 6px;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .reject-modal .preview-comment {
    padding: 6px 10px; border-left: 3px solid var(--blue); background: var(--bg);
    border-radius: 0 6px 6px 0; font-size: 12px; color: var(--text2);
    line-height: 1.5; margin-bottom: 4px;
  }
  .reject-modal .preview-comment .comment-file {
    font-family: var(--mono); font-size: 11px; color: var(--text3);
  }
  .reject-modal .preview-feedback {
    padding: 8px 12px; background: var(--bg); border-radius: 6px;
    font-size: 12px; color: var(--text2); white-space: pre-wrap; font-family: var(--mono);
  }
  .reject-modal .modal-actions { display: flex; gap: 10px; margin-top: 16px; }
  .reject-modal .btn-confirm-reject {
    padding: 8px 20px; border-radius: 8px; font-size: 12px; font-weight: 600;
    cursor: pointer; border: none; background: var(--red); color: #fff;
  }
  .reject-modal .btn-cancel-reject {
    padding: 8px 20px; border-radius: 8px; font-size: 12px; font-weight: 600;
    cursor: pointer; background: var(--bg3); color: var(--text3); border: 1px solid var(--border);
  }

  @media (max-width: 640px) {
    .steps-grid { grid-template-columns: repeat(auto-fill, minmax(62px, 1fr)); }
    .input-bar { flex-wrap: wrap; }
    .input-bar label { width: 100%; }
  }

  /* ── Enhancement 1: Toast Notification System ── */
  .toast-container {
    position: fixed; bottom: 24px; right: 24px; z-index: 2000;
    display: flex; flex-direction: column-reverse; gap: 8px; pointer-events: none;
  }
  .toast {
    pointer-events: auto; padding: 12px 20px; border-radius: 10px;
    font-size: 13px; font-weight: 500; max-width: 380px; min-width: 220px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4); display: flex; align-items: center; gap: 10px;
    animation: toastIn 0.3s ease-out forwards;
  }
  .toast.toast-exit { animation: toastOut 0.3s ease-in forwards; }
  .toast-success { background: var(--green-bg); border: 1px solid #1a4a2e; color: var(--green); }
  .toast-error { background: var(--red-bg); border: 1px solid #5a2020; color: var(--red); }
  .toast-info { background: var(--blue-bg); border: 1px solid #1f3058; color: var(--blue); }
  .toast-icon { font-size: 16px; flex-shrink: 0; }
  .toast-dismiss {
    margin-left: auto; cursor: pointer; opacity: 0.6; font-size: 16px;
    background: none; border: none; color: inherit; padding: 0 0 0 8px;
  }
  .toast-dismiss:hover { opacity: 1; }

  /* ── Enhancement 2: Button Loading States ── */
  .btn-loading {
    position: relative; pointer-events: none; opacity: 0.7;
  }
  .btn-loading::before {
    content: ""; display: inline-block; width: 14px; height: 14px;
    border: 2px solid currentColor; border-top-color: transparent;
    border-radius: 50%; margin-right: 8px; vertical-align: middle;
    animation: btnSpin 0.6s linear infinite;
  }
  @keyframes btnSpin { to { transform: rotate(360deg); } }

  /* ── Enhancement 3: Pipeline Progress Bar ── */
  .progress-bar-wrap {
    position: fixed; top: 0; left: 0; right: 0; height: 3px;
    background: var(--bg3); z-index: 1500; overflow: hidden;
  }
  .progress-bar-fill {
    height: 100%; width: 0; background: linear-gradient(90deg, var(--blue), var(--purple));
    transition: width 0.6s ease; position: relative;
  }
  .progress-bar-fill::after {
    content: ""; position: absolute; right: 0; top: -1px; width: 80px; height: 5px;
    background: linear-gradient(90deg, transparent, rgba(76,141,255,0.5));
    animation: progressPulse 2s ease-in-out infinite;
  }
  @keyframes progressPulse { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }

  /* ── Enhancement 4: Keyboard Shortcuts Modal ── */
  .shortcuts-modal-overlay {
    display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.6); z-index: 1800; align-items: center; justify-content: center;
  }
  .shortcuts-modal-overlay.visible { display: flex; }
  .shortcuts-modal {
    background: var(--bg2); border: 1.5px solid var(--border); border-radius: 12px;
    padding: 24px; max-width: 440px; width: 90%;
  }
  .shortcuts-modal h3 {
    font-size: 15px; font-weight: 600; margin-bottom: 16px; color: var(--text);
    display: flex; align-items: center; gap: 8px;
  }
  .shortcut-row {
    display: flex; align-items: center; gap: 12px; padding: 8px 0;
    border-bottom: 1px solid var(--border); font-size: 13px;
  }
  .shortcut-row:last-child { border-bottom: none; }
  .shortcut-key {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 28px; height: 26px; padding: 0 8px; border-radius: 6px;
    background: var(--bg3); border: 1px solid var(--border);
    font-family: var(--mono); font-size: 12px; font-weight: 600; color: var(--text);
  }
  .shortcut-desc { color: var(--text2); }

  /* ── Enhancement 5: Smooth Animations & Transitions ── */
  @keyframes slideDown { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes toastIn { from { opacity: 0; transform: translateX(40px); } to { opacity: 1; transform: translateX(0); } }
  @keyframes toastOut { from { opacity: 1; transform: translateX(0); } to { opacity: 0; transform: translateX(40px); } }

  .banner-enter { animation: slideDown 0.3s ease-out; }
  .review-panel-enter { animation: fadeIn 0.3s ease-out; }
  .step-pill { transition: all 0.2s ease, transform 0.15s ease, box-shadow 0.15s ease; }
  .step-pill:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important; animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
    .step-pill:hover { transform: none; box-shadow: none; }
  }

  /* ── Enhancement 6: Tooltips on Step Pills ── */
  .step-pill { position: relative; }
  .step-tooltip {
    visibility: hidden; opacity: 0; position: absolute; bottom: calc(100% + 8px); left: 50%;
    transform: translateX(-50%); background: #1e2030; border: 1px solid var(--border);
    border-radius: 8px; padding: 10px 14px; font-size: 11px; line-height: 1.5;
    white-space: nowrap; z-index: 100; pointer-events: none;
    transition: visibility 0.15s, opacity 0.15s; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  }
  .step-tooltip::after {
    content: ""; position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
    border: 6px solid transparent; border-top-color: var(--border);
  }
  .step-tooltip .tt-title { font-weight: 600; color: var(--text); margin-bottom: 2px; }
  .step-tooltip .tt-who { color: var(--text3); }
  .step-tooltip .tt-timing { color: var(--blue); margin-top: 2px; }
  .step-pill:hover .step-tooltip { visibility: visible; opacity: 1; }

  /* ── Enhancement 7: Copy-to-Clipboard Buttons ── */
  .copy-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; border-radius: 5px; cursor: pointer;
    background: transparent; border: 1px solid transparent; color: var(--text3);
    font-size: 12px; transition: all 0.15s; flex-shrink: 0; padding: 0;
  }
  .copy-btn:hover { background: var(--bg3); border-color: var(--border); color: var(--text); }
  .copy-btn.copied { color: var(--green); border-color: #1a4a2e; }

  /* ── Enhancement 9: Collapsible Sections ── */
  .collapsible-header {
    display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;
  }
  .collapsible-header .collapse-arrow {
    font-size: 10px; color: var(--text3); transition: transform 0.2s; display: inline-block;
  }
  .collapsible-header.collapsed .collapse-arrow { transform: rotate(-90deg); }
  .collapsible-content {
    max-height: 2000px; overflow: hidden; transition: max-height 0.3s ease, opacity 0.2s ease; opacity: 1;
  }
  .collapsible-content.collapsed { max-height: 0; opacity: 0; overflow: hidden; }

  /* ── Enhancement 10: Heartbeat & Last Updated Indicator ── */
  .heartbeat-wrap {
    display: flex; align-items: center; gap: 8px; margin-left: 12px;
  }
  .heartbeat {
    width: 8px; height: 8px; border-radius: 50%; background: var(--text3);
    display: inline-block; flex-shrink: 0;
  }
  .heartbeat.connected { background: var(--green); animation: heartbeatPulse 2s infinite; }
  .heartbeat.disconnected { background: var(--red); }
  @keyframes heartbeatPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(74,222,128,0.4); } 50% { box-shadow: 0 0 0 4px rgba(74,222,128,0); } }
  .last-updated { font-size: 11px; color: var(--text3); white-space: nowrap; }

  /* Sub-stage progress pills */
  .substage-bar { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
  .ss-pill { padding: 4px 10px; border-radius: 12px; font-size: 11px;
    border: 1px solid var(--border); background: var(--bg2); color: var(--text3); }
  .ss-pill.ss-done { border-color: var(--green); color: var(--green); background: var(--green-bg); }
  .ss-pill.ss-active { border-color: var(--blue); color: var(--blue); background: var(--blue-bg);
    animation: pulse 2s infinite; }
  .ss-pill.ss-pending { opacity: 0.5; }

  /* ================================================================
     RESILIENCE LAYER — CSS
     ================================================================ */

  /* ── Light/Dark Theme Toggle ── */
  :root[data-theme="light"] {
    --bg: #f5f6fa; --bg2: #ffffff; --bg3: #e9ebf0; --border: #d1d5e0;
    --text: #1a1d27; --text2: #5c6180; --text3: #9499b3;
    --blue: #2563eb; --blue-bg: #dbeafe; --green: #16a34a; --green-bg: #dcfce7;
    --red: #dc2626; --red-bg: #fee2e2; --yellow: #ca8a04; --yellow-bg: #fef9c3;
    --purple: #7c3aed; --purple-bg: #ede9fe;
  }
  .theme-toggle {
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; border-radius: 8px; cursor: pointer;
    background: var(--bg3); border: 1px solid var(--border); color: var(--text2);
    font-size: 16px; transition: all 0.2s; margin-left: 8px; padding: 0;
  }
  .theme-toggle:hover { color: var(--text); border-color: var(--text3); }

  /* ── Skip to Content Link ── */
  .skip-link {
    position: absolute; top: -100px; left: 8px; z-index: 9999;
    padding: 8px 16px; background: var(--blue); color: #fff;
    border-radius: 0 0 8px 8px; font-size: 13px; font-weight: 600;
    text-decoration: none; transition: top 0.2s;
  }
  .skip-link:focus { top: 0; }

  /* ── Skeleton Loading ── */
  @keyframes shimmer {
    0% { background-position: -400px 0; }
    100% { background-position: 400px 0; }
  }
  .skeleton {
    background: linear-gradient(90deg, var(--bg3) 25%, var(--bg2) 50%, var(--bg3) 75%);
    background-size: 800px 100%;
    animation: shimmer 1.5s infinite ease-in-out;
    border-radius: 8px;
  }
  .skeleton-pill { width: 88px; height: 64px; border-radius: 10px; }
  .skeleton-card { width: 100%; height: 120px; border-radius: 12px; margin-bottom: 24px; }
  .skeleton-log { width: 100%; height: 360px; border-radius: 10px; }
  .skeleton-row { width: 100%; height: 36px; border-radius: 6px; margin-bottom: 6px; }
  .skeleton-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
    gap: 8px; margin-bottom: 24px;
  }

  /* ── Connection / Offline Banners ── */
  .connection-banner {
    display: none; padding: 10px 16px; border-radius: 8px; margin-bottom: 16px;
    font-size: 13px; font-weight: 500; text-align: center;
    align-items: center; justify-content: center; gap: 10px;
  }
  .connection-banner.visible { display: flex; }
  .connection-banner.offline {
    background: var(--red-bg); border: 1px solid #5a2020; color: var(--red);
  }
  .connection-banner.stale {
    background: var(--yellow-bg); border: 1px solid #5a4a10; color: var(--yellow);
  }
  .connection-banner.reconnecting {
    background: var(--blue-bg); border: 1px solid #1f3058; color: var(--blue);
  }
  .connection-banner .retry-btn {
    padding: 4px 14px; border-radius: 6px; font-size: 12px; font-weight: 600;
    cursor: pointer; border: 1px solid currentColor; background: transparent;
    color: inherit; transition: all 0.15s;
  }
  .connection-banner .retry-btn:hover { background: rgba(255,255,255,0.1); }
  .connection-banner .countdown { font-family: var(--mono); font-weight: 700; }

  /* ── Error Classification Overlays ── */
  .error-overlay {
    display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.7); z-index: 2500; align-items: center;
    justify-content: center;
  }
  .error-overlay.visible { display: flex; }
  .error-card {
    background: var(--bg2); border: 1.5px solid var(--border); border-radius: 12px;
    padding: 32px; max-width: 440px; width: 90%; text-align: center;
  }
  .error-card .error-icon { font-size: 48px; margin-bottom: 16px; display: block; }
  .error-card .error-title { font-size: 18px; font-weight: 700; margin-bottom: 8px; }
  .error-card .error-msg { font-size: 13px; color: var(--text2); margin-bottom: 20px; line-height: 1.6; }
  .error-card .error-countdown {
    font-family: var(--mono); font-size: 24px; font-weight: 700;
    color: var(--yellow); margin-bottom: 16px;
  }
  .error-card .error-btn {
    padding: 10px 28px; border-radius: 8px; font-size: 13px; font-weight: 600;
    cursor: pointer; border: none; background: var(--blue); color: #fff;
    transition: all 0.2s;
  }
  .error-card .error-btn:hover { opacity: 0.9; }
  .error-card .error-btn-secondary {
    padding: 10px 28px; border-radius: 8px; font-size: 13px; font-weight: 600;
    cursor: pointer; background: var(--bg3); color: var(--text2);
    border: 1px solid var(--border); margin-left: 8px;
  }

  /* ── Rate Limit Banner ── */
  .rate-limit-banner {
    display: none; padding: 10px 16px; border-radius: 8px; margin-bottom: 16px;
    background: var(--yellow-bg); border: 1px solid #5a4a10;
    color: var(--yellow); font-size: 13px; font-weight: 500; text-align: center;
  }
  .rate-limit-banner.visible { display: block; }

  /* ── Draft Restored Toast Badge ── */
  .draft-badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: 4px; font-size: 10px;
    background: var(--yellow-bg); color: var(--yellow); font-weight: 600;
  }

  /* ── Diff Progress Indicator ── */
  .diff-progress {
    display: none; padding: 16px; text-align: center; font-size: 13px;
    color: var(--text2);
  }
  .diff-progress.visible { display: block; }
  .diff-progress-bar {
    width: 100%; height: 4px; background: var(--bg3); border-radius: 2px;
    overflow: hidden; margin-top: 8px;
  }
  .diff-progress-fill {
    height: 100%; background: var(--blue); transition: width 0.3s ease;
    border-radius: 2px;
  }
  .diff-large-warning {
    padding: 8px 12px; border-radius: 6px; font-size: 12px;
    background: var(--yellow-bg); color: var(--yellow); margin-bottom: 8px;
    display: none;
  }
  .diff-large-warning.visible { display: block; }

  /* ── Focus Trap Indicator ── */
  .focus-trap-active { box-shadow: 0 0 0 3px var(--blue); }

  /* ── Accessible Comment Triggers ── */
  .comment-trigger {
    opacity: 0.3;  /* Always slightly visible, not just on hover */
  }
  .diff-table tr:hover .comment-trigger,
  .comment-trigger:focus { opacity: 1; }
  .comment-trigger:focus-visible {
    outline: 2px solid var(--blue);
    outline-offset: 1px;
  }

  /* ── Non-Color Diff Indicators ── */
  .diff-prefix-symbol { user-select: none; font-weight: 700; }
  .diff-prefix-add::before { content: "+"; }
  .diff-prefix-del::before { content: "-"; }

  /* ── ARIA Live Region ── */
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
  }

  /* ── Route Transitions ── */
  .route-view { transition: opacity 0.2s ease; }
  .route-view.fading { opacity: 0; }

  /* ── Offline Action Buttons ── */
  .btn-offline {
    opacity: 0.4; cursor: not-allowed; position: relative;
  }
  .btn-offline::after {
    content: "Server unreachable";
    position: absolute; bottom: calc(100% + 6px); left: 50%;
    transform: translateX(-50%); background: var(--bg3); color: var(--text3);
    font-size: 10px; padding: 3px 8px; border-radius: 4px;
    white-space: nowrap; pointer-events: none; opacity: 0;
    transition: opacity 0.15s;
  }
  .btn-offline:hover::after { opacity: 1; }

  /* ── Settings Page (future route) ── */
  .settings-page { padding: 24px 0; }
  .settings-page h2 { font-size: 18px; font-weight: 600; margin-bottom: 16px; }

  /* ── 404 Page ── */
  .not-found { text-align: center; padding: 60px 20px; }
  .not-found h2 { font-size: 48px; color: var(--text3); margin-bottom: 12px; }
  .not-found p { font-size: 14px; color: var(--text2); margin-bottom: 24px; }

  /* ================================================================
     RESILIENCE LAYER v2 — Enhanced CSS
     ================================================================ */

  /* ── Cross-Tab Sync Indicator ── */
  .toast-sync { background: var(--purple-bg); border: 1px solid #3a2860; color: var(--purple); }
  .tab-leader-badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: 4px; font-size: 10px;
    background: var(--green-bg); color: var(--green); font-weight: 600;
    margin-left: 6px;
  }
  .tab-follower-badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: 4px; font-size: 10px;
    background: var(--bg3); color: var(--text3); font-weight: 600;
    margin-left: 6px;
  }

  /* ── Enhanced Review Panel Loading ── */
  .review-loading {
    display: flex; align-items: center; justify-content: center; gap: 12px;
    padding: 32px; color: var(--text2); font-size: 13px;
  }
  .review-loading-spinner {
    width: 20px; height: 20px; border: 2px solid var(--border);
    border-top-color: var(--blue); border-radius: 50%;
    animation: btnSpin 0.8s linear infinite;
  }

  /* ── Settings Page Content ── */
  .settings-page .settings-section {
    background: var(--bg2); border: 1px solid var(--border); border-radius: 12px;
    padding: 20px 24px; margin-bottom: 16px;
  }
  .settings-page .settings-section h3 {
    font-size: 14px; font-weight: 600; margin-bottom: 12px;
    color: var(--text);
  }
  .settings-page .settings-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 0; border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .settings-page .settings-row:last-child { border-bottom: none; }
  .settings-page .settings-label { color: var(--text2); }
  .settings-page .settings-value {
    font-family: var(--mono); font-size: 12px; color: var(--text);
  }
  .settings-toggle-switch {
    position: relative; width: 40px; height: 22px;
    background: var(--bg3); border-radius: 11px; cursor: pointer;
    border: 1px solid var(--border); transition: all 0.2s;
  }
  .settings-toggle-switch.active {
    background: var(--green-bg); border-color: var(--green);
  }
  .settings-toggle-switch::after {
    content: ""; position: absolute; top: 2px; left: 2px;
    width: 16px; height: 16px; border-radius: 50%;
    background: var(--text3); transition: all 0.2s;
  }
  .settings-toggle-switch.active::after {
    left: 20px; background: var(--green);
  }

  /* ── Enhanced Error Overlay States ── */
  .error-overlay .error-actions {
    display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;
  }

  /* ── Enhanced Offline Button Tooltip ── */
  .btn-offline-group { position: relative; display: inline-block; }
  .btn-offline-tooltip {
    visibility: hidden; opacity: 0; position: absolute;
    bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
    background: var(--bg3); color: var(--text3); font-size: 10px;
    padding: 4px 10px; border-radius: 4px; white-space: nowrap;
    transition: visibility 0.15s, opacity 0.15s;
    pointer-events: none; z-index: 10;
    border: 1px solid var(--border);
  }
  .btn-offline:hover + .btn-offline-tooltip,
  .btn-offline-group:hover .btn-offline-tooltip {
    visibility: visible; opacity: 1;
  }

  /* ── Enhanced Diff Prefix Symbols (non-color indicators) ── */
  .diff-line-add .diff-symbol-prefix,
  .split-line-add .diff-symbol-prefix {
    color: var(--green); font-weight: 700; user-select: none;
  }
  .diff-line-del .diff-symbol-prefix,
  .split-line-del .diff-symbol-prefix {
    color: var(--red); font-weight: 700; user-select: none;
  }

  /* ── Accessible Comment Trigger — keyboard visible at all times ── */
  .comment-trigger[tabindex="0"] {
    opacity: 0.3;
  }
  .diff-table tr:hover .comment-trigger[tabindex="0"],
  .comment-trigger[tabindex="0"]:focus { opacity: 1; }

  /* ── Route Active Nav Indicator ── */
  .route-nav {
    display: flex; gap: 4px; margin-bottom: 16px;
    border-bottom: 2px solid var(--border); padding-bottom: 8px;
  }
  .route-nav-item {
    padding: 6px 16px; border-radius: 6px 6px 0 0; font-size: 12px;
    font-weight: 600; cursor: pointer; border: none;
    background: transparent; color: var(--text3); transition: all 0.15s;
    font-family: var(--sans); text-decoration: none;
  }
  .route-nav-item:hover { color: var(--text); background: var(--bg3); }
  .route-nav-item.active {
    color: var(--blue); background: var(--blue-bg);
    border-bottom: 2px solid var(--blue); margin-bottom: -10px;
  }

  /* ── Draft Indicator on Textareas ── */
  .textarea-draft-indicator {
    position: absolute; top: 4px; right: 8px; font-size: 9px;
    color: var(--yellow); font-weight: 600; pointer-events: none;
  }
  .textarea-wrap { position: relative; }

  /* ── Network Error Banner Enhanced ── */
  .network-error-detail {
    font-family: var(--mono); font-size: 11px; color: var(--text3);
    margin-top: 4px;
  }
</style>
</head>
<body>
<!-- Accessibility: Skip to content link -->
<a href="#mainContent" class="skip-link">Skip to main content</a>

<!-- Accessibility: ARIA live region for state change announcements -->
<div id="ariaLiveRegion" class="sr-only" aria-live="assertive" aria-atomic="true" role="status"></div>

<!-- Enhancement 3: Pipeline Progress Bar -->
<div class="progress-bar-wrap" id="progressBarWrap">
  <div class="progress-bar-fill" id="progressBarFill"></div>
</div>

<!-- Error Classification Overlay (session expired, server error) -->
<div class="error-overlay" id="errorOverlay">
  <div class="error-card" id="errorCard" role="alertdialog" aria-labelledby="errorTitle" aria-describedby="errorMsg">
    <span class="error-icon" id="errorIcon"></span>
    <div class="error-title" id="errorTitle"></div>
    <div class="error-msg" id="errorMsg"></div>
    <div class="error-countdown" id="errorCountdown" style="display:none"></div>
    <div>
      <button class="error-btn" id="errorAction" onclick="dismissErrorOverlay()">OK</button>
      <button class="error-btn-secondary" id="errorSecondary" style="display:none" onclick="dismissErrorOverlay()">Dismiss</button>
    </div>
  </div>
</div>

<div class="container" id="mainContent">
<div id="subStageProgress"></div>

  <!-- Header -->
  <div class="header">
    <span class="header-icon" aria-hidden="true">&#x1F916;</span>
    <div>
      <h1>AI Dev Agent</h1>
      <p>Jira &#x2192; Claude &#x2192; GitLab &#x2192; QA &#x2192; Pre-Prod &#x2192; Production</p>
    </div>
    <div id="statusBadge" class="header-status idle" role="status">Idle</div>
    <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" aria-label="Toggle light/dark theme" title="Toggle theme">&#x263E;</button>
    <div class="heartbeat-wrap">
      <span class="heartbeat" id="heartbeat" aria-hidden="true"></span>
      <span class="last-updated" id="lastUpdated"></span>
    </div>
  </div>

  <!-- Input -->
  <div class="input-bar">
    <label for="ticket">Jira Ticket</label>
    <input id="ticket" type="text" value="" placeholder="e.g. AUT-1234" spellcheck="false">
    <button id="btnStart" class="btn btn-start" onclick="start()" aria-label="Start the agent pipeline">Start Agent</button>
    <button id="btnStop" class="btn btn-stop" onclick="stop()" style="display:none" aria-label="Stop the running agent">Stop</button>
    <button class="btn btn-reset" onclick="reset()" aria-label="Reset agent state and clear all progress">Reset</button>
    <button class="btn btn-reset" id="btnSkipStage" onclick="skipStage()" title="Skip current stage (requires ALLOW_STAGE_SKIP=true)" aria-label="Skip the current pipeline stage">Skip Stage</button>
  </div>

  <!-- Connection / Offline Banners -->
  <div class="connection-banner offline" id="offlineBanner" role="alert">
    <span aria-hidden="true">&#x26A0;</span>
    <span>Connection lost</span>
    <span class="countdown" id="offlineCountdown"></span>
    <button class="retry-btn" onclick="retryConnectionNow()" aria-label="Retry connection now">Retry Now</button>
  </div>
  <div class="connection-banner stale" id="staleBanner" role="status">
    <span aria-hidden="true">&#x23F3;</span>
    <span>Showing cached data</span>
    <span id="staleAge"></span>
  </div>
  <div class="connection-banner reconnecting" id="reconnectBanner" role="status">
    <span aria-hidden="true">&#x1F504;</span>
    <span>Connected! Syncing...</span>
  </div>
  <div class="rate-limit-banner" id="rateLimitBanner" role="alert">
    Rate limited &mdash; retrying in <span class="countdown" id="rateLimitCountdown"></span>s
  </div>

  <!-- O5: Error/warning banners -->
  <div id="errorBanner"></div>
  <div id="warningBanner"></div>

  <!-- O2: Stuck detection banner -->
  <div id="stuckBanner"></div>

  <!-- O9: Context injection panel (visible only when agent is running) -->
  <div class="context-inject-panel" id="contextInjectPanel" style="display:none">
    <h4>Inject Context</h4>
    <textarea id="contextInjectText" placeholder="Add additional context for the running agent (e.g., clarifications, constraints, API details)..." aria-label="Context injection text"></textarea>
    <div class="inject-actions">
      <button class="btn-inject" id="btnInjectContext" onclick="injectContext()" aria-label="Inject additional context into the running agent">Inject Context</button>
      <span class="inject-status" id="injectStatus"></span>
    </div>
  </div>

  <!-- O4: Log file viewer panel -->
  <div class="log-viewer-panel" id="logViewerPanel" style="display:none">
    <div class="log-viewer-header" id="logViewerHeader" onclick="toggleLogViewer()" role="button" tabindex="0" aria-label="Toggle agent log file viewer" onkeydown="if(event.key==='Enter')toggleLogViewer()">
      <span class="toggle-icon" id="logViewerToggle">&#9654;</span>
      <h4>Agent Log File</h4>
      <span class="log-total" id="logViewerTotal">0 lines</span>
    </div>
    <div class="log-viewer-content" id="logViewerContent"></div>
  </div>

  <!-- Y5: Step pills with ARIA roles -->
  <div class="steps-grid" id="stepsGrid" role="tablist" aria-label="Pipeline steps"></div>

  <!-- Detail card -->
  <div class="detail-card" id="detailCard" role="tabpanel"></div>

  <!-- 9.1-9.3: Runtime test results panel -->
  <div id="testResultsPanel"></div>

  <!-- Review panel (diff viewer + approve/reject) -->
  <div id="reviewPanel">
    <div class="review-title">
      <span>Review</span>
      <span class="gate-badge" id="gateBadge"></span>
    </div>
    <div id="planViewer">
      <div class="plan-summary" id="planSummary" style="display:none"></div>
      <div class="plan-tabs" id="planTabs"></div>
      <div class="plan-tab-content" id="planTabContent"></div>
      <div class="plan-suggestions" id="planSuggestions" style="display:none"></div>
    </div>
    <div id="diffViewer">
      <div id="diffStats" class="diff-stats"></div>
      <div class="diff-file-search" id="diffFileSearch" style="display:none">
        <input type="text" id="diffSearchInput" placeholder="Filter files..." oninput="filterDiffFiles()" aria-label="Filter changed files by name">
        <span class="match-count" id="diffSearchCount"></span>
      </div>
      <div class="diff-file-tabs" id="diffFileTabs" role="tablist" aria-label="Changed files"></div>
      <div class="diff-toolbar" id="diffToolbar" style="display:none">
        <div class="diff-mode-toggle">
          <button class="diff-mode-btn active" id="btnUnified" onclick="setDiffMode('unified')" aria-label="Show unified diff view">Unified</button>
          <button class="diff-mode-btn" id="btnSplit" onclick="setDiffMode('split')" aria-label="Show split diff view">Split</button>
        </div>
      </div>
      <div class="diff-large-warning" id="diffLargeWarning" role="alert">
        <span aria-hidden="true">&#x26A0;</span> This file has 2000+ lines &mdash; rendering may be slow
      </div>
      <div id="diffFileLabel"></div>
      <div class="diff-progress" id="diffProgress" role="progressbar" aria-valuemin="0" aria-valuemax="100">
        <span id="diffProgressText">Rendering files...</span>
        <div class="diff-progress-bar"><div class="diff-progress-fill" id="diffProgressFill"></div></div>
      </div>
      <div class="diff-table-wrap"><table class="diff-table" id="diffTable"></table></div>
      <div id="diffInfo"></div>
    </div>
    <div id="qaViewer"></div>
    <div id="mrViewer"></div>
    <div class="review-actions" id="reviewActions">
      <button class="btn-approve" id="btnApprove" onclick="approveGate()" aria-label="Approve this gate and proceed to next stage">Approve</button>
      <button class="btn-reject" id="btnReject" onclick="showRejectForm()" aria-label="Reject and provide feedback for regeneration">Reject</button>
      <button class="btn-refine" id="btnRefine" onclick="showRefineForm()" style="display:none" aria-label="Request refinement of the plan with additional instructions">Refine</button>
      <span class="review-status" id="reviewStatus"></span>
    </div>
    <div class="approval-status" id="approvalStatus"></div>
    <div id="rejectFeedback">
      <textarea id="rejectText" placeholder="Describe what needs to change..." aria-label="Rejection feedback"></textarea>
      <button onclick="rejectGate()" aria-label="Submit rejection feedback">Submit Rejection</button>
    </div>
    <div id="refineFeedback">
      <textarea id="refineText" placeholder="e.g., dive deeper into API integration, add error handling specs, explore the existing reconcile module for patterns..." aria-label="Refinement instructions"></textarea>
      <button onclick="submitRefine()" aria-label="Submit plan refinement instructions">Submit Refinement</button>
    </div>
  </div>

  <!-- Nav -->
  <div class="nav">
    <button class="btn btn-reset" id="btnPrev" onclick="nav(-1)" aria-label="Go to previous pipeline step">&#x2190; Prev</button>
    <button class="btn btn-reset" id="btnNext" onclick="nav(1)" aria-label="Go to next pipeline step">Next &#x2192;</button>
    <span class="counter" id="counter"></span>
  </div>

  <!-- Logs (Enhancement 9: Collapsible) -->
  <div class="log-section">
    <div class="log-header collapsible-header" id="logOutput-header" onclick="toggleSection('logOutput')" role="button" tabindex="0" aria-expanded="true" aria-label="Toggle live output log section" onkeydown="if(event.key==='Enter')toggleSection('logOutput')">
      <span class="collapse-arrow" aria-hidden="true">&#9660;</span>
      <h3>Live Output</h3>
      <span class="log-count" id="logCount">0 lines</span>
    </div>
    <div id="logOutput-content">
      <div class="log-terminal" id="logTerminal" role="log" aria-live="polite" aria-label="Agent output log"></div>
    </div>
  </div>

  <!-- Summary (Enhancement 9: Collapsible) -->
  <div class="summary">
    <h3 class="collapsible-header" id="summary-header" onclick="toggleSection('summary')" role="button" tabindex="0" aria-expanded="true" aria-label="Toggle summary section" onkeydown="if(event.key==='Enter')toggleSection('summary')"><span class="collapse-arrow" aria-hidden="true">&#9660;</span> Summary &mdash; what you do vs what's automatic</h3>
    <div id="summary-content">
      <div id="summaryTable"></div>
    </div>
  </div>

</div>

<!-- Enhancement 1: Toast container -->
<div class="toast-container" id="toastContainer" role="status" aria-live="polite"></div>

<!-- Enhancement 4: Keyboard shortcuts modal -->
<div class="shortcuts-modal-overlay" id="shortcutsModal" onclick="if(event.target===this)hideShortcutsModal()">
  <div class="shortcuts-modal">
    <h3>Keyboard Shortcuts</h3>
    <div class="shortcut-row"><span class="shortcut-key">?</span><span class="shortcut-desc">Show this help</span></div>
    <div class="shortcut-row"><span class="shortcut-key">j</span><span class="shortcut-desc">Next step</span></div>
    <div class="shortcut-row"><span class="shortcut-key">k</span><span class="shortcut-desc">Previous step</span></div>
    <div class="shortcut-row"><span class="shortcut-key">Esc</span><span class="shortcut-desc">Close modal / form</span></div>
    <div class="shortcut-row"><span class="shortcut-key">a</span><span class="shortcut-desc">Approve (when gate active)</span></div>
    <div class="shortcut-row"><span class="shortcut-key">r</span><span class="shortcut-desc">Show reject form (when gate active)</span></div>
    <div class="shortcut-row"><span class="shortcut-key">f</span><span class="shortcut-desc">Show refine form (plan review only)</span></div>
  </div>
</div>

<!-- U8: Rejection preview modal -->
<div class="reject-modal-overlay" id="rejectPreviewModal" onclick="if(event.target===this)closeRejectPreview()">
  <div class="reject-modal">
    <h3>Confirm Rejection</h3>
    <div id="rejectPreviewContent"></div>
    <div class="modal-actions">
      <button class="btn-confirm-reject" onclick="confirmReject()" aria-label="Confirm and submit rejection with feedback">Confirm Rejection</button>
      <button class="btn-cancel-reject" onclick="closeRejectPreview()" aria-label="Cancel rejection and return to review">Cancel</button>
    </div>
  </div>
</div>

<script>
// M6: Auth token injected at render time
const API_TOKEN = ${JSON.stringify(apiToken)};

// Y14: javascript: URL prevention
function safeHref(url) {
  if (!url) return "#";
  try {
    var u = new URL(url, window.location.origin);
    if (u.protocol === "http:" || u.protocol === "https:") return url;
  } catch {}
  return "#";
}

// Y9: Fetch with timeout helper (now uses classifiedFetch for error handling)
function fetchWithTimeout(url, options, timeoutMs) {
  return classifiedFetch(url, options, timeoutMs || 10000);
}

// ── Enhancement 1: Toast Notification System ──
var toastId = 0;
function showToast(message, type, durationMs) {
  type = type || "info";
  durationMs = durationMs || 3000;
  var container = document.getElementById("toastContainer");
  if (!container) return;
  var id = ++toastId;
  var icons = { success: "\\u2705", error: "\\u274C", info: "\\u2139\\uFE0F" };
  var toast = document.createElement("div");
  toast.className = "toast toast-" + type;
  toast.id = "toast-" + id;
  toast.innerHTML = '<span class="toast-icon">' + (icons[type] || icons.info) + '</span>' +
    '<span>' + escHtml(message) + '</span>' +
    '<button class="toast-dismiss" onclick="dismissToast(' + id + ')">&times;</button>';
  container.appendChild(toast);
  setTimeout(function() { dismissToast(id); }, durationMs);
}
function dismissToast(id) {
  var el = document.getElementById("toast-" + id);
  if (!el || el.classList.contains("toast-exit")) return;
  el.classList.add("toast-exit");
  setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
}

// ── Enhancement 2: Button Loading States ──
function setButtonLoading(btn, loading, originalText) {
  if (!btn) return;
  if (loading) {
    if (!btn.dataset.origText) btn.dataset.origText = btn.textContent;
    btn.classList.add("btn-loading");
    btn.disabled = true;
    btn.textContent = originalText || "Processing...";
  } else {
    btn.classList.remove("btn-loading");
    btn.disabled = false;
    btn.textContent = btn.dataset.origText || originalText || btn.textContent;
    delete btn.dataset.origText;
  }
}

// ── Enhancement 3: Progress Bar Update ──
function updateProgressBar() {
  if (!currentStage) {
    document.getElementById("progressBarFill").style.width = "0%";
    return;
  }
  var ci = STAGE_ORDER.indexOf(currentStage);
  if (ci < 0) ci = 0;
  var pct;
  if (currentStage === "done") {
    pct = 100;
  } else if (currentStage === "generate_code" && lastStateData) {
    // Sub-step progress within generate_code (3 sub-steps = 0.33 each)
    var subProgress = 0;
    if (lastStateData._dev_complete && lastStateData._reviewed && lastStateData._fixed) subProgress += 0.33;
    if (lastStateData._test_phase_complete) subProgress += 0.33;
    if (lastStateData.code_mr_iid) subProgress += 0.34;
    pct = Math.round(((ci + subProgress) / STAGE_ORDER.length) * 100);
  } else {
    pct = Math.round(((ci + 0.5) / STAGE_ORDER.length) * 100);
  }
  document.getElementById("progressBarFill").style.width = pct + "%";
}

// ── Enhancement 7: Copy to Clipboard ──
function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() {
      showToast("Copied to clipboard", "success", 2000);
    }).catch(function() {
      showToast("Copy failed", "error", 2000);
    });
  } else {
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.left = "-9999px";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); showToast("Copied to clipboard", "success", 2000); }
    catch(e) { showToast("Copy failed", "error", 2000); }
    document.body.removeChild(ta);
  }
}

// ── Enhancement 9: Collapsible Sections ──
function toggleSection(sectionId) {
  var content = document.getElementById(sectionId + "-content");
  var header = document.getElementById(sectionId + "-header");
  if (!content || !header) return;
  var collapsed = content.classList.toggle("collapsed");
  header.classList.toggle("collapsed", collapsed);
  // Update aria-expanded for accessibility
  header.setAttribute("aria-expanded", collapsed ? "false" : "true");
  try { localStorage.setItem("section-" + sectionId, collapsed ? "1" : "0"); } catch(e) {}
}
function restoreCollapsedSections() {
  ["summary", "logOutput", "contextPanel"].forEach(function(id) {
    try {
      var stored = localStorage.getItem("section-" + id);
      if (stored === "1") {
        var content = document.getElementById(id + "-content");
        var header = document.getElementById(id + "-header");
        if (content) content.classList.add("collapsed");
        if (header) header.classList.add("collapsed");
      }
    } catch(e) {}
  });
}

// ── Enhancement 10: Heartbeat / Last Updated ──
var lastPollTime = 0;
var heartbeatTimer = null;
function updateHeartbeat() {
  var dot = document.getElementById("heartbeat");
  var label = document.getElementById("lastUpdated");
  if (!dot || !label) return;
  dot.className = "heartbeat " + (isOnline ? "connected" : "disconnected");
  dot.setAttribute("aria-label", isOnline ? "Connected" : "Disconnected");
  if (!lastPollTime) { label.textContent = ""; return; }
  var secs = Math.round((Date.now() - lastPollTime) / 1000);
  if (secs < 5) label.textContent = "just now";
  else if (secs < 60) label.textContent = secs + "s ago";
  else label.textContent = Math.floor(secs / 60) + "m ago";
}

// ── Connection State Management ─────────────────────────────────
var fetchErrorCount = 0;
var MAX_FETCH_ERRORS = 3;
var isOnline = true;
var lastCacheTime = 0;

function setOnlineState(online) {
  var wasOffline = !isOnline;
  isOnline = online;

  var offBanner = document.getElementById("offlineBanner");
  var staleBanner = document.getElementById("staleBanner");

  if (online) {
    if (offBanner) offBanner.classList.remove("visible");
    if (staleBanner) staleBanner.classList.remove("visible");
    // Re-enable action buttons (including form submit buttons)
    document.querySelectorAll(".btn-offline").forEach(function(el) {
      el.classList.remove("btn-offline");
      el.disabled = false;
    });
    // Clear stale rate-limit banner if still showing
    var rlBanner = document.getElementById("rateLimitBanner");
    if (rlBanner) rlBanner.classList.remove("visible");
  } else {
    if (offBanner) offBanner.classList.add("visible");
    // Show stale data banner if we have cached state
    if (lastCacheTime && staleBanner) {
      staleBanner.classList.add("visible");
      updateStaleAge();
    }
    // Disable action buttons (including form submit buttons)
    ["btnStart","btnStop","btnApprove","btnReject","btnRefine","btnInjectContext","btnSkipStage"].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) { el.classList.add("btn-offline"); el.disabled = true; }
    });
    // Also disable submit buttons inside feedback forms
    document.querySelectorAll("#rejectFeedback button, #refineFeedback button, .inject-actions button, .btn-confirm-reject").forEach(function(btn) {
      btn.classList.add("btn-offline");
      btn.disabled = true;
    });
  }
  updateHeartbeat();
}

function updateStaleAge() {
  var el = document.getElementById("staleAge");
  if (!el || !lastCacheTime) return;
  var secs = Math.round((Date.now() - lastCacheTime) / 1000);
  if (secs < 60) el.textContent = "-- last updated " + secs + "s ago";
  else if (secs < 3600) el.textContent = "-- last updated " + Math.floor(secs/60) + "m ago";
  else el.textContent = "-- last updated " + Math.floor(secs/3600) + "h ago";
}

function showReconnectBanner() {
  var banner = document.getElementById("reconnectBanner");
  if (banner) {
    banner.classList.add("visible");
    setTimeout(function() { banner.classList.remove("visible"); }, 3000);
  }
  showToast("Connected! Syncing...", "success", 3000);
  announceToScreenReader("Connection restored. Syncing latest data.");
}

function onFetchSuccess() {
  var wasOffline = fetchErrorCount >= MAX_FETCH_ERRORS;
  fetchErrorCount = 0;
  if (wasOffline) {
    setOnlineState(true);
    showReconnectBanner();
    onConnectionRestored();
  }
  // Cache state for offline mode
  cacheCurrentState();
}

function onFetchError() {
  fetchErrorCount++;
  if (fetchErrorCount >= MAX_FETCH_ERRORS) {
    setOnlineState(false);
  }
}

// ── Error Classification & Recovery ─────────────────────────────

/**
 * Enhanced fetch wrapper with error classification.
 * Replaces authPost for all API calls.
 */
function classifiedFetch(url, options, timeoutMs) {
  timeoutMs = timeoutMs || 10000;
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  var opts = Object.assign({}, options || {}, { signal: controller.signal });

  return fetch(url, opts).then(function(res) {
    clearTimeout(timer);

    if (res.ok) {
      onFetchSuccess();
      return res;
    }

    // Classify error by status code
    if (res.status === 401 || res.status === 403) {
      showErrorOverlay("session_expired", "Session Expired", "Your session token is invalid or has expired. Please refresh the page to get a new token.", "Refresh Page", function() { window.location.reload(); });
      throw new Error("Session expired (HTTP " + res.status + ")");
    }

    if (res.status === 429) {
      var retryAfter = parseInt(res.headers.get("Retry-After") || "60", 10);
      showRateLimitBanner(retryAfter);
      throw new Error("Rate limited — retry in " + retryAfter + "s");
    }

    if (res.status >= 500) {
      showErrorOverlay("server_error", "Server Error",
        "The server encountered an internal error (HTTP " + res.status + "). Check server logs for details.",
        "Retry", function() {
          dismissErrorOverlay();
          retryConnectionNow();
        }, true /* showDismiss */);
      onFetchError();
      throw new Error("Server error (HTTP " + res.status + ")");
    }

    return res;
  }).catch(function(err) {
    clearTimeout(timer);

    if (err.name === "AbortError") {
      showToast("Request timed out -- retrying...", "error", 4000);
      onFetchError();
      throw new Error("Request timed out");
    }

    // Catch all network errors (covers different browser messages)
    if (err.message === "Failed to fetch" ||
        err.message === "NetworkError when attempting to fetch resource." ||
        err.message === "Load failed" ||
        err.name === "TypeError") {
      onFetchError();
      announceToScreenReader("Connection lost. Attempting to reconnect.");
      throw new Error("Network error");
    }

    throw err;
  });
}

function showErrorOverlay(type, title, msg, actionLabel, actionFn, showDismiss) {
  var overlay = document.getElementById("errorOverlay");
  var iconEl = document.getElementById("errorIcon");
  var titleEl = document.getElementById("errorTitle");
  var msgEl = document.getElementById("errorMsg");
  var actionBtn = document.getElementById("errorAction");
  var secondaryBtn = document.getElementById("errorSecondary");
  var countdownEl = document.getElementById("errorCountdown");

  var icons = {
    session_expired: "&#x1F512;",
    server_error: "&#x26A0;",
    rate_limited: "&#x23F3;",
    network_error: "&#x1F4E1;",
  };

  iconEl.innerHTML = icons[type] || "&#x26A0;";
  titleEl.textContent = title;
  msgEl.textContent = msg;
  actionBtn.textContent = actionLabel || "OK";
  actionBtn.onclick = actionFn || dismissErrorOverlay;
  actionBtn.setAttribute("aria-label", actionLabel || "OK");

  // Show/hide dismiss button
  if (showDismiss && secondaryBtn) {
    secondaryBtn.style.display = "";
    secondaryBtn.textContent = "Dismiss";
    secondaryBtn.onclick = dismissErrorOverlay;
  } else if (secondaryBtn) {
    secondaryBtn.style.display = "none";
  }

  // Hide countdown unless rate-limited
  if (countdownEl) countdownEl.style.display = "none";

  overlay.classList.add("visible");
  // Announce to screen reader
  announceToScreenReader(title + ". " + msg);
  // Focus trap
  trapFocus(overlay.querySelector(".error-card"));
}

function dismissErrorOverlay() {
  var overlay = document.getElementById("errorOverlay");
  overlay.classList.remove("visible");
  releaseFocusTrap();
}

var _rateLimitTimer = null;
function showRateLimitBanner(seconds) {
  var banner = document.getElementById("rateLimitBanner");
  var countdown = document.getElementById("rateLimitCountdown");
  if (!banner || !countdown) return;
  banner.classList.add("visible");
  if (_rateLimitTimer) clearInterval(_rateLimitTimer);
  var remaining = seconds;
  countdown.textContent = remaining;
  announceToScreenReader("Rate limited. Retrying in " + remaining + " seconds.");
  _rateLimitTimer = setInterval(function() {
    remaining--;
    countdown.textContent = remaining;
    if (remaining <= 0) {
      clearInterval(_rateLimitTimer);
      _rateLimitTimer = null;
      banner.classList.remove("visible");
      announceToScreenReader("Rate limit cleared. Resuming.");
      // Auto-retry the connection
      retryConnectionNow();
    }
  }, 1000);
}

// Upgrade authPost to use classified fetch
function authPost(url, body) {
  return classifiedFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Token": API_TOKEN },
    body: JSON.stringify(body),
  });
}

// ── Enhancement 4: Keyboard Shortcuts ──
function showShortcutsModal() {
  document.getElementById("shortcutsModal").className = "shortcuts-modal-overlay visible";
  trapFocus(document.querySelector(".shortcuts-modal"));
}
function hideShortcutsModal() {
  document.getElementById("shortcutsModal").className = "shortcuts-modal-overlay";
  releaseFocusTrap();
}
document.addEventListener("keydown", function(e) {
  var tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case "?":
      e.preventDefault();
      var modal = document.getElementById("shortcutsModal");
      if (modal.classList.contains("visible")) hideShortcutsModal();
      else showShortcutsModal();
      break;
    case "j":
      e.preventDefault(); nav(1); break;
    case "k":
      e.preventDefault(); nav(-1); break;
    case "Escape":
      hideShortcutsModal();
      closeRejectPreview();
      document.getElementById("rejectFeedback").className = "";
      document.getElementById("refineFeedback").className = "";
      break;
    case "a":
      if (reviewData && reviewData.gate) {
        var btnA = document.getElementById("btnApprove");
        if (btnA && !btnA.disabled) { e.preventDefault(); approveGate(); }
      }
      break;
    case "r":
      if (reviewData && reviewData.gate) {
        var btnR = document.getElementById("btnReject");
        if (btnR && !btnR.disabled) { e.preventDefault(); showRejectForm(); }
      }
      break;
    case "f":
      if (reviewData && reviewData.gate === "explore_plan") {
        var btnF = document.getElementById("btnRefine");
        if (btnF && !btnF.disabled && btnF.style.display !== "none") { e.preventDefault(); showRefineForm(); }
      }
      break;
  }
});

const STEPS = [
  { num: 1,  stage: "fetch_ticket",          who: "you",   title: "You run one command",                   what: "node run-agent.js",                                              detail: "You open terminal, go to the folder, and type this one command. That's all you do to start.",                                                                                                    icon: "\u25B6" },
  { num: 2,  stage: "fetch_ticket",          who: "agent", title: "Agent reads your Jira ticket",          what: "Fetches ticket from mastersindia-sols.atlassian.net",             detail: "The agent automatically connects to Jira and reads the ticket title, description, and acceptance criteria.",                                                                                      icon: "\uD83C\uDFAB" },
  { num: 3,  stage: "explore_plan",          who: "both",  title: "Explore & Plan — review the plan",      what: "Agents team analyzes ticket, you approve the plan",               detail: "4 AI agents (Analyst, Explorer, Risk, Architect) analyze the ticket and build an implementation plan. You review and approve or reject it here.",                                                  icon: "\uD83D\uDCCB", youDo: "Review plan below \u2192 click Approve or Reject" },
  { num: 4,  stage: "generate_code",         who: "agent", title: "Agent writes code",                      what: "Developer \u2192 Reviewer \u2192 Fixer",                                  detail: "Claude reads the ticket and approved plan, writes code changes, then a Reviewer agent checks quality and a Fixer agent resolves any issues found.",                                                  icon: "\uD83D\uDCBB", substageKey: "generate_code_write", doneWhen: ["_dev_complete", "_reviewed", "_fixed"] },
  { num: 5,  stage: "generate_code",         who: "agent", title: "Agent tests & verifies",                what: "Build \u2192 Unit Tests \u2192 E2E \u2192 Browser \u2192 AC Check",          detail: "Build check ensures code compiles. Unit tests and E2E browser smoke tests validate functionality. AC verification confirms all acceptance criteria are met.",                                        icon: "\uD83E\uDDEA", substageKey: "generate_code_test", doneWhen: ["_test_phase_complete"] },
  { num: 6,  stage: "generate_code",         who: "agent", title: "Agent creates MR",                      what: "Branch \u2192 Commit \u2192 MR \u2192 Slack",                                detail: "Creates branch enterprise-ts-{ticket}, commits with your details, creates MR on GitLab assigned to you, and sends a Slack notification with the MR link.",                                          icon: "\uD83D\uDD00", substageKey: "generate_code_push", doneWhen: ["code_mr_iid"] },
  { num: 7,  stage: "gate_code_review",      who: "you",   title: "GATE 1 \u2014 Review code diffs",             what: "Review diffs here or on GitLab MR",                               detail: "The agent PAUSES. Review the code diffs below with the GitHub-style viewer. Click Approve to proceed or Reject with feedback to regenerate.",                                                      icon: "\u23F8",  youDo: "Review diffs below \u2192 click Approve or Reject" },
  { num: 8,  stage: "deploy_qa",             who: "agent", title: "Agent deploys to QA automatically",     what: "Merges MR \u2192 enterprise-qa \u2192 CI runs",                            detail: "After your approval the agent merges the code and waits for CI pipeline on enterprise-qa.",                                                                                                       icon: "\uD83D\uDE80" },
  { num: 9,  stage: "test_qa",               who: "agent", title: "Agent tests all 7 modules on QA",      what: "Dashboard, GST Return, Reports, Config, Import, IMS, Reconcile", detail: "The agent checks that all 7 modules load and work correctly on QA. If anything fails it stops.",                                                                                                     icon: "\uD83E\uDDEA" },
  { num: 10, stage: "gate_preprod_approval",  who: "you",   title: "GATE 2a \u2014 Approve pre-prod",             what: "QA verified \u2192 approve promotion to Pre-Prod",                   detail: "Agent pauses. QA test results shown below. Click Approve to promote to Pre-Prod.",                                                                                                                icon: "\u23F8",  youDo: "Review QA results \u2192 click Approve" },
  { num: 11, stage: "create_preprod_mr",     who: "agent", title: "Agent creates Pre-Prod MR",             what: "enterprise-qa \u2192 enterprise-pre-pro",                             detail: "Agent creates a Merge Request on GitLab from enterprise-qa to enterprise-pre-pro.",                                                                                                                icon: "\uD83D\uDD00" },
  { num: 12, stage: "gate_dual_approval",    who: "both",  title: "GATE 2b \u2014 You AND Anshit approve",     what: "Both must approve to proceed",                                   detail: "BOTH you and Anshit Malhotra need to approve. Click Approve below or comment on Jira.",                                                                                                           icon: "\u23F8",  youDo: "Click Approve below" },
  { num: 13, stage: "deploy_prod",           who: "agent", title: "Agent deploys Pre-Prod + Production",   what: "CI \u2192 Pre-Prod \u2192 smoke tests \u2192 Production",                   detail: "After both approvals the agent merges the Pre-Prod MR, waits for CI, runs smoke tests, then deploys to Production.",                                                                               icon: "\uD83C\uDF0D" },
  { num: 14, stage: "done",                  who: "agent", title: "Done \u2014 Jira closed + Slack notification", what: "Ticket \u2192 Done. Everyone gets notified.",                       detail: "Jira ticket is moved to Done with a full summary. Everyone gets a Slack message with links.",                                                                                                      icon: "\u2705" },
];

const STAGE_ORDER = ${JSON.stringify(STAGES)};

const GATE_STAGES = {
  explore_plan: "explore_plan",
  gate_code_review: "gate1",
  deploy_qa: "deploy_qa",
  gate_preprod_approval: "gate2a",
  gate_dual_approval: "gate2b",
};

const WHO_LABELS = { you: "YOU act", agent: "Automatic", both: "BOTH act" };
const WHO_CLASS  = { you: "who-you", agent: "who-agent", both: "who-both" };

let activeStep = 0;
var userSelectedStep = false;
let isRunning = false;
// O2: Stuck detection state
var isStuck = false;
var stuckMinutes = 0;
// O4: Log viewer state
var logViewerOpen = false;
var logViewerInterval = null;
let currentStage = null;
let evtSource = null;

// ── Render ──────────────────────────────────────────────────────

function getStepStatus(step) {
  if (!currentStage) return "pending";
  const ci = STAGE_ORDER.indexOf(currentStage);
  const si = STAGE_ORDER.indexOf(step.stage);
  if (currentStage === "done") return "done";
  if (si < ci) return "done";
  if (si > ci) return "pending";
  // si === ci — same stage. For generate_code sub-steps, use doneWhen to differentiate.
  if (step.doneWhen && lastStateData) {
    var allDone = step.doneWhen.every(function(k) { return !!lastStateData[k]; });
    if (allDone) return "done";
    // Check if a prior generate_code step is NOT done yet — this one is still pending
    for (var j = 0; j < STEPS.length; j++) {
      if (STEPS[j] === step) break;
      if (STEPS[j].stage === step.stage && STEPS[j].doneWhen) {
        var priorDone = STEPS[j].doneWhen.every(function(k) { return !!lastStateData[k]; });
        if (!priorDone) return "pending";
      }
    }
    return "active";
  }
  return "active";
}

// O14: Format duration in human-readable form
function formatDuration(ms) {
  if (!ms || ms < 0) return "";
  var secs = Math.floor(ms / 1000);
  if (secs < 60) return secs + "s";
  var mins = Math.floor(secs / 60);
  var remSecs = secs % 60;
  if (mins < 60) return mins + "m " + (remSecs > 0 ? remSecs + "s" : "");
  var hrs = Math.floor(mins / 60);
  var remMins = mins % 60;
  return hrs + "h " + (remMins > 0 ? remMins + "m" : "");
}

// O14: Get timing for a stage from _metrics
function getStageTiming(stage) {
  if (!lastStateData || !lastStateData._metrics) return "";
  var metrics = lastStateData._metrics;
  var stageMetric = metrics[stage];
  if (!stageMetric) return "";
  if (stageMetric.duration_ms) return formatDuration(stageMetric.duration_ms);
  if (stageMetric.start_ts) {
    // Stage is in progress — show elapsed time
    var elapsed = Date.now() - stageMetric.start_ts;
    return formatDuration(elapsed) + "...";
  }
  return "";
}

function renderPills() {
  const grid = document.getElementById("stepsGrid");
  grid.innerHTML = STEPS.map((s, i) => {
    const status = getStepStatus(s);
    const cls = i === activeStep ? "active" : status === "done" ? "done" : status === "active" ? "current" : "";
    const selected = i === activeStep ? "true" : "false";
    // O14: Per-stage timing display
    var timing = getStageTiming(s.stage);
    var timingHtml = timing ? '<span style="font-size:9px;color:var(--text3);margin-top:1px">' + escHtml(timing) + '</span>' : "";
    var whoLabel = WHO_LABELS[s.who] || s.who;
    var ttHtml = '<div class="step-tooltip"><div class="tt-title">' + escHtml(s.title) + '</div><div class="tt-who">' + escHtml(whoLabel) + '</div>' + (timing ? '<div class="tt-timing">' + escHtml(timing) + '</div>' : '') + '</div>';
    return '<button class="step-pill ' + cls + '" role="tab" aria-selected="' + selected + '" tabindex="' + (i === activeStep ? '0' : '-1') + '" onclick="setActive(' + i + ')" aria-label="Step ' + s.num + ': ' + escHtml(s.title) + (timing ? ' (' + timing + ')' : '') + '">' +
      ttHtml +
      '<span class="icon">' + s.icon + '</span>' +
      '<span class="num">' + s.num + '</span>' + timingHtml + '</button>';
  }).join("");
}

function renderDetail() {
  const s = STEPS[activeStep];
  const card = document.getElementById("detailCard");
  card.innerHTML =
    '<div class="step-header">' +
      '<span class="step-icon">' + s.icon + '</span>' +
      '<div>' +
        '<div class="step-label" style="color:var(--text3)">Step ' + s.num + '</div>' +
        '<div class="step-title">' + s.title + '</div>' +
      '</div>' +
      '<div class="who-badge ' + WHO_CLASS[s.who] + '">' + WHO_LABELS[s.who] + '</div>' +
    '</div>' +
    '<div class="detail-what">' + s.what + '</div>' +
    '<div class="detail-text">' + s.detail + '</div>' +
    (s.youDo ? '<div class="detail-action">What you do: ' + s.youDo + '</div>' : '');

  document.getElementById("counter").textContent = (activeStep + 1) + " of " + STEPS.length;
  document.getElementById("btnPrev").disabled = activeStep === 0;
  document.getElementById("btnNext").disabled = activeStep === STEPS.length - 1;
}

function renderSummary() {
  const table = document.getElementById("summaryTable");
  table.innerHTML = STEPS.map((s, i) => {
    const status = getStepStatus(s);
    const cls = status === "done" ? "s-done" : status === "active" ? "s-active" : "s-pending";
    const label = status === "done" ? "Done" : status === "active" ? "Active" : "Pending";
    return '<div class="summary-row" onclick="setActive(' + i + ')">' +
      '<span class="s-icon">' + s.icon + '</span>' +
      '<span class="s-title">' + s.title + '</span>' +
      '<span class="s-status ' + cls + '">' + label + '</span>' +
    '</div>';
  }).join("");
}

function render() {
  renderPills();
  renderDetail();
  renderSummary();
  renderReviewPanel();
  renderBanners();
  renderStuckBanner();
  renderApprovalStatus();
  renderTestResults();
  const badge = document.getElementById("statusBadge");
  badge.className = "header-status " + (isRunning ? "running" : "idle");
  badge.textContent = isRunning ? "Running" : "Idle";
  document.getElementById("btnStart").style.display = isRunning ? "none" : "";
  document.getElementById("btnStop").style.display = isRunning ? "" : "none";
  document.getElementById("btnStart").disabled = isRunning;
  // O9: Show context injection panel only when agent is running
  document.getElementById("contextInjectPanel").style.display = isRunning ? "" : "none";
  // O4: Show log viewer panel when there is a ticket with state
  var hasState = currentStage !== null;
  document.getElementById("logViewerPanel").style.display = hasState ? "" : "none";
  // Enhancement 3: Progress bar
  updateProgressBar();
  // Enhancement 10: Heartbeat
  updateHeartbeat();
  // Sub-stage progress pills
  renderSubStageProgress();
}

// ── Sub-stage progress pills ──
var SUBSTAGES = {
  explore_plan: [
    { key: "_agent_requirements", label: "Requirements" },
    { key: "_agent_explorer",     label: "Code Explorer" },
    { key: "_agent_risk",         label: "Risk Analyst" },
    { key: "_agent_analysis",     label: "Analysis" },
    { key: "explore_plan",        label: "Architect Plan" },
    { key: "explore_plan_posted", label: "Awaiting Review" },
  ],
  generate_code_write: [
    { key: "_dev_complete",         label: "Developer" },
    { key: "_reviewed",             label: "Reviewer" },
    { key: "_fixed",                label: "Fixer" },
  ],
  generate_code_test: [
    { key: "_build_checked",        label: "Build Check" },
    { key: "_env_bootstrapped",     label: "Env Bootstrap" },
    { key: "_unit_tests_complete",  label: "Unit Tests" },
    { key: "_e2e_tests_complete",   label: "E2E Tests" },
    { key: "_routes_detected",      label: "Routes" },
    { key: "_login_complete",       label: "Login" },
    { key: "_browser_verified",     label: "Browser Verify" },
    { key: "_ac_verified",          label: "AC Verified" },
  ],
  generate_code_push: [
    { key: "code_branch",           label: "Branch" },
    { key: "code_committed",        label: "Commit" },
    { key: "code_mr_iid",           label: "MR Created" },
    { key: "code_slack_sent",       label: "Notified" },
  ],
  deploy_qa: [
    { key: "qa_merged",  label: "MR Merged" },
    { key: "qa_ci",      label: "CI Pipeline" },
  ],
  deploy_prod: [
    { key: "preprod_ci",           label: "Pre-Prod CI" },
    { key: "preprod_smoke_passed", label: "Pre-Prod Smoke" },
    { key: "prod_mr_iid",         label: "Prod MR" },
    { key: "prod_merged",         label: "Prod Merged" },
  ],
};

function renderSubStageProgress() {
  var el = document.getElementById("subStageProgress");
  if (!el || !lastStateData) { if (el) el.innerHTML = ""; return; }
  // Use the active step's substageKey if it has one, otherwise fall back to currentStage
  var activeStepObj = STEPS[activeStep];
  var ssKey = (activeStepObj && activeStepObj.substageKey) ? activeStepObj.substageKey : currentStage;
  var ss = SUBSTAGES[ssKey];
  if (!ss) { el.innerHTML = ""; return; }
  var activeAgents = lastStateData._active_agents || [];
  var html = '<div class="substage-bar">';
  var foundActive = false;
  for (var i = 0; i < ss.length; i++) {
    var done = !!lastStateData[ss[i].key];
    var isActive = activeAgents.some(function(a) {
      return ss[i].label.toLowerCase().indexOf(a.toLowerCase().replace(/ agent$/i, "")) >= 0;
    });
    var cls;
    if (done) {
      cls = "ss-done";
    } else if (isActive) {
      foundActive = true;
      cls = "ss-active";
    } else if (!foundActive) {
      foundActive = true;
      cls = "ss-active";
    } else {
      cls = "ss-pending";
    }
    html += '<span class="ss-pill ' + cls + '">' + escHtml(ss[i].label) + '</span>';
  }
  el.innerHTML = html + '</div>';
}

// O5: Error/warning banners
var lastStateData = null;
function renderBanners() {
  var errEl = document.getElementById("errorBanner");
  var warnEl = document.getElementById("warningBanner");
  if (!lastStateData) { errEl.innerHTML = ""; warnEl.innerHTML = ""; return; }
  if (lastStateData._lastError) {
    errEl.innerHTML = '<div class="banner-error banner-enter">Error: ' + escHtml(lastStateData._lastError) + ' <span class="copy-btn" onclick="copyToClipboard(this.parentNode.textContent)" title="Copy error" style="display:inline-flex;vertical-align:middle">&#x2398;</span></div>';
  } else { errEl.innerHTML = ""; }
  if (lastStateData._warnings && lastStateData._warnings.length > 0) {
    var items = lastStateData._warnings.map(function(w) { return "<li>" + escHtml(w) + "</li>"; }).join("");
    warnEl.innerHTML = '<div class="banner-warning">Warnings:<ul>' + items + '</ul></div>';
  } else { warnEl.innerHTML = ""; }
}

// O2: Stuck detection banner
function renderStuckBanner() {
  var el = document.getElementById("stuckBanner");
  if (!isStuck || !isRunning) { el.innerHTML = ""; return; }
  var severe = stuckMinutes >= 30;
  var cls = severe ? "banner-stuck severe" : "banner-stuck";
  var msg = severe
    ? "AGENT APPEARS STUCK — no activity for " + stuckMinutes + " minutes. Consider stopping and restarting."
    : "POSSIBLY STUCK — no agent activity for " + stuckMinutes + " minutes. The agent may be processing a large task.";
  el.innerHTML = '<div class="' + cls + '"><span class="stuck-icon">' + (severe ? "&#9888;" : "&#9200;") + '</span>' + escHtml(msg) + '</div>';
}

// O13: Approval status during gate stages
function renderApprovalStatus() {
  var el = document.getElementById("approvalStatus");
  if (!el) return;
  if (!lastStateData || !reviewData || !reviewData.gate) { el.innerHTML = ""; return; }
  var gate = GATE_STAGES[reviewData.gate] || reviewData.gate;
  var approved = lastStateData[gate + "_ui_approved"];
  var rejected = lastStateData[gate + "_ui_rejected"];
  if (reviewData.gate === "gate_dual_approval") {
    var yogApproved = lastStateData["gate2b_ui_approved"];
    var anshitApproved = lastStateData["gate2b_anshit_approved"];
    var parts = [];
    parts.push("Yogendra: " + (yogApproved ? '<span class="approved">Approved</span>' : '<span class="pending">Pending</span>'));
    parts.push("Anshit: " + (anshitApproved ? '<span class="approved">Approved</span>' : '<span class="pending">Pending</span>'));
    el.innerHTML = parts.join(" &middot; ");
  } else if (rejected) {
    // T7: Check rejected FIRST — reject takes priority in race conditions
    el.innerHTML = '<span style="color:var(--red);font-weight:600">Rejected</span>';
  } else if (approved) {
    el.innerHTML = '<span class="approved">Approved</span>';
  } else {
    el.innerHTML = '<span class="pending">Awaiting approval</span>';
  }
}

// 9.1-9.3: Render runtime test results panel
function renderTestResults() {
  var panel = document.getElementById("testResultsPanel");
  if (!panel || !lastStateData) { if (panel) panel.className = ""; return; }

  var unitStatus = lastStateData._unit_tests_complete;
  var e2eStatus = lastStateData._e2e_tests_complete;
  if (!unitStatus && !e2eStatus) { panel.className = ""; return; }

  panel.className = "visible";
  var html = '<div class="test-results-card"><div class="test-results-title">Runtime Test Results</div>';

  // 9.1: Unit test badge + 9.2: count display
  if (unitStatus) {
    var ut = lastStateData._unit_tests_count || {};
    var badgeCls = unitStatus === "PASS" ? "pass" : unitStatus === "FAIL" ? "fail" : "inconclusive";
    html += '<div class="test-result-row">' +
      '<span class="test-badge ' + badgeCls + '">' + escHtml(unitStatus) + '</span>' +
      '<span>Unit Tests</span>' +
      '<span style="color:var(--text3);font-size:11px;margin-left:auto">';
    if (ut.total) {
      html += escHtml(ut.passed + '/' + ut.total + ' passed');
      if (ut.flaky > 0) html += ', ' + escHtml(String(ut.flaky)) + ' flaky';
    }
    html += '</span></div>';
  }

  // 9.3: E2E test status with console error count
  if (e2eStatus) {
    var et = lastStateData._e2e_tests_count || {};
    var eBadge = e2eStatus === "PASS" ? "pass" : e2eStatus === "FAIL" ? "fail" : "inconclusive";
    var consoleErrors = lastStateData._e2e_console_errors || [];
    html += '<div class="test-result-row">' +
      '<span class="test-badge ' + eBadge + '">' + escHtml(e2eStatus) + '</span>' +
      '<span>Browser Smoke</span>' +
      '<span style="color:var(--text3);font-size:11px;margin-left:auto">';
    if (et.total) html += escHtml(et.passed + '/' + et.total + ' passed');
    if (consoleErrors.length > 0) html += ' (' + consoleErrors.length + ' console errors)';
    html += '</span></div>';
  }

  // 9.5: Test artifacts link
  var artifactsPath = lastStateData._test_artifacts_path;
  if (artifactsPath) {
    html += '<div style="margin-top:8px;font-size:11px;color:var(--text3)">' +
      'Artifacts: <code>' + escHtml(artifactsPath) + '</code></div>';
  }

  html += '</div>';
  panel.innerHTML = html;
}

// Find the best step index for a stage — for multi-step stages (generate_code),
// returns the first step whose doneWhen is NOT yet satisfied (i.e., currently active).
function findActiveStepForStage(stage) {
  var lastMatch = -1;
  for (var i = 0; i < STEPS.length; i++) {
    if (STEPS[i].stage !== stage) continue;
    lastMatch = i;
    if (STEPS[i].doneWhen && lastStateData) {
      var allDone = STEPS[i].doneWhen.every(function(k) { return !!lastStateData[k]; });
      if (!allDone) return i; // This sub-step is in progress
    } else if (!STEPS[i].doneWhen) {
      return i; // No doneWhen — return first match
    }
  }
  return lastMatch >= 0 ? lastMatch : STEPS.findIndex(function(s) { return s.stage === stage; });
}
function setActive(i) { activeStep = i; userSelectedStep = true; render(); }
function nav(d) { setActive(Math.max(0, Math.min(STEPS.length - 1, activeStep + d))); }

// ── Log output ──────────────────────────────────────────────────

const logEl = document.getElementById("logTerminal");
let logLines = 0;

function appendLog(entry) {
  const div = document.createElement("div");
  div.className = "log-line " + (entry.type || "stdout");
  // Strip ANSI codes for display
  div.textContent = entry.line.replace(/\\x1b\\[[0-9;]*m/g, "").replace(/\x1b\[[0-9;]*m/g, "");
  div.style.cursor = "pointer";
  div.title = "Click to copy";
  div.onclick = function() { copyToClipboard(div.textContent); };
  logEl.appendChild(div);
  while (logEl.children.length > 500) logEl.removeChild(logEl.firstChild);
  logLines++;
  document.getElementById("logCount").textContent = logLines + " lines";
  // Auto-scroll only when user is at bottom
  var isAtBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30;
  if (isAtBottom) logEl.scrollTop = logEl.scrollHeight;
}

// ── SSE connection (Robust: auth, reconnect, cross-tab, offline) ──

var sseRetryDelay = 3000;
var sseWasDisconnected = false;
var sseReconnectTimer = null;
var sseAutoRetryCountdown = 0;
var sseCountdownTimer = null;

function connectSSE() {
  // If we are not the leader tab, skip SSE — rely on BroadcastChannel
  if (typeof crossTab !== "undefined" && !crossTab.isLeader) return;

  // Close previous EventSource and remove all listeners to prevent accumulation
  if (evtSource) {
    try {
      evtSource.onopen = null;
      evtSource.onerror = null;
      evtSource.close();
    } catch {}
    evtSource = null;
  }
  // Clear any pending reconnect timer to avoid duplicate connects
  if (sseReconnectTimer) { clearTimeout(sseReconnectTimer); sseReconnectTimer = null; }
  logEl.innerHTML = "";
  logLines = 0;

  // Auth: pass token as query param (EventSource doesn't support headers)
  evtSource = new EventSource("/api/logs?token=" + encodeURIComponent(API_TOKEN));

  evtSource.addEventListener("log", function(e) {
    try {
      var data = JSON.parse(e.data);
      appendLog(data);
      // Broadcast to other tabs
      if (typeof crossTab !== "undefined") crossTab.send("sse:log", data);
    } catch {}
  });

  evtSource.addEventListener("status", function(e) {
    try {
      var data = JSON.parse(e.data);
      isRunning = data.running;
      render();
      // Broadcast to other tabs
      if (typeof crossTab !== "undefined") crossTab.send("sse:status", data);
    } catch {}
  });

  evtSource.addEventListener("review", function(e) {
    try {
      var data = JSON.parse(e.data);
      // Broadcast to other tabs to prevent double-approve
      if (typeof crossTab !== "undefined") crossTab.send("sse:review", data);
    } catch {}
  });

  evtSource.onopen = function() {
    sseRetryDelay = 3000;
    clearCountdown();
    if (sseWasDisconnected) {
      sseWasDisconnected = false;
      showReconnectBanner();
      showToast("Connection restored", "success", 2000);
      onConnectionRestored();
    }
    setOnlineState(true);
  };

  evtSource.onerror = function() {
    sseWasDisconnected = true;
    setOnlineState(false);
    startRetryCountdown(sseRetryDelay);
    sseReconnectTimer = setTimeout(connectSSE, sseRetryDelay);
    sseRetryDelay = Math.min(sseRetryDelay * 2, 60000);
  };
}

function retryConnectionNow() {
  clearCountdown();
  if (sseReconnectTimer) { clearTimeout(sseReconnectTimer); sseReconnectTimer = null; }
  sseRetryDelay = 3000;
  connectSSE();
  pollState();
  fetchReview();
}

function startRetryCountdown(delayMs) {
  clearCountdown();
  sseAutoRetryCountdown = Math.ceil(delayMs / 1000);
  var el = document.getElementById("offlineCountdown");
  if (el) el.textContent = "(" + sseAutoRetryCountdown + "s)";
  sseCountdownTimer = setInterval(function() {
    sseAutoRetryCountdown--;
    if (el) el.textContent = sseAutoRetryCountdown > 0 ? "(" + sseAutoRetryCountdown + "s)" : "";
    if (sseAutoRetryCountdown <= 0) clearCountdown();
  }, 1000);
}

function clearCountdown() {
  if (sseCountdownTimer) { clearInterval(sseCountdownTimer); sseCountdownTimer = null; }
  sseAutoRetryCountdown = 0;
  var el = document.getElementById("offlineCountdown");
  if (el) el.textContent = "";
}

// ── API calls ───────────────────────────────────────────────────

async function start() {
  const ticket = document.getElementById("ticket").value.trim();
  if (!ticket) return showToast("Enter a Jira ticket ID", "error");
  var btnS = document.getElementById("btnStart");
  setButtonLoading(btnS, true, "Starting...");
  try {
    const res = await authPost("/api/start", { ticket });
    const data = await res.json();
    if (!data.ok) { showToast(data.error, "error"); setButtonLoading(btnS, false, "Start Agent"); }
    else { isRunning = true; showToast("Agent started for " + ticket, "success"); render(); }
  } catch (e) { showToast("Start failed: " + e.message, "error"); setButtonLoading(btnS, false, "Start Agent"); }
}

async function stop() {
  var ticket = document.getElementById("ticket").value.trim() || "";
  if (!confirm("Stop the agent" + (ticket ? " for " + ticket : "") + "?")) return;
  var btnSt = document.getElementById("btnStop");
  setButtonLoading(btnSt, true, "Stopping...");
  try {
    await authPost("/api/stop", { ticket: ticket });
    isRunning = false;
    showToast("Agent stopped", "info");
    render();
  } catch (e) { showToast("Stop failed: " + e.message, "error"); setButtonLoading(btnSt, false, "Stop"); }
}

async function reset() {
  const ticket = document.getElementById("ticket").value.trim() || "";
  if (!confirm("Reset state for " + ticket + "? This clears all progress.")) return;
  try {
    await authPost("/api/reset", { ticket });
    currentStage = null;
    activeStep = 0;
    // Clear live output terminal
    logEl.innerHTML = "";
    logLines = 0;
    document.getElementById("logCount").textContent = "0 lines";
    // Clear log viewer
    document.getElementById("logViewerContent").innerHTML = "";
    document.getElementById("logViewerTotal").textContent = "0 lines";
    // Clear review panel
    reviewData = null;
    renderReviewPanel();
    lastStateData = null;
    showToast("State reset for " + ticket, "info");
    render();
  } catch (e) { showToast("Reset failed: " + e.message, "error"); }
}

// O7: Skip current stage (manual advance)
async function skipStage() {
  var ticket = document.getElementById("ticket").value.trim() || "";
  var stage = currentStage || "unknown";
  if (!confirm("Skip stage '" + stage + "' for " + ticket + "?\\n\\nThis sets _force_advance=true, which the agent checks to advance past the current gate.\\n\\nRequires ALLOW_STAGE_SKIP=true on server.")) return;
  try {
    var btnSkip = document.getElementById("btnSkipStage");
    setButtonLoading(btnSkip, true, "Skipping...");
    var res = await authPost("/api/skip-stage", { ticket: ticket, confirm: true });
    var data = await res.json();
    setButtonLoading(btnSkip, false, "Skip Stage");
    if (!data.ok) showToast("Skip failed: " + data.error, "error");
    else { showToast("Stage skip requested. Agent will advance on next poll.", "success"); pollState(); }
  } catch (e) { showToast("Skip failed: " + e.message, "error"); }
}

// ── LCS Diff Algorithm ──────────────────────────────────────────

function computeDiff(oldLines, newLines) {
  const n = oldLines.length, m = newLines.length;
  // Fallback for very large files
  if (n > 2000 || m > 2000) {
    const result = [];
    for (let i = 0; i < n; i++) result.push({ type: "del", oldNum: i + 1, newNum: null, text: oldLines[i] });
    for (let j = 0; j < m; j++) result.push({ type: "add", oldNum: null, newNum: j + 1, text: newLines[j] });
    return result;
  }
  // DP table for LCS
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    dp[i] = new Uint16Array(m + 1);
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  // Backtrack to build diff
  const result = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: "ctx", oldNum: i, newNum: j, text: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: "add", oldNum: null, newNum: j, text: newLines[j - 1] });
      j--;
    } else {
      result.push({ type: "del", oldNum: i, newNum: null, text: oldLines[i - 1] });
      i--;
    }
  }
  result.reverse();
  return result;
}

// ── Review Panel ────────────────────────────────────────────────

let reviewData = null;
let reviewFileIdx = 0;
let reviewInterval = null;
let diffMode = localStorage.getItem("diffMode") || "unified";
let reviewLineComments = {};  // { filePath: { lineKey: [{text, timestamp}] } }
// U4: Multiple open comment forms — map of lineKey -> draft text
let openCommentForms = {};    // { lineKey: draftText }
let diffFileFilter = "";      // U6: current file search filter

// U10: Binary file detection — check for null bytes
function isBinaryContent(content) {
  if (!content) return false;
  for (var i = 0; i < Math.min(content.length, 8000); i++) {
    if (content.charCodeAt(i) === 0) return true;
  }
  return false;
}

// U6: File search/filter
function filterDiffFiles() {
  var input = document.getElementById("diffSearchInput");
  diffFileFilter = (input ? input.value : "").toLowerCase().trim();
  renderReviewPanel();
}

// U7: Compute file change stats
function computeDiffStats(changes) {
  var added = 0, modified = 0, deleted = 0, linesAdded = 0, linesDeleted = 0;
  (changes || []).forEach(function(c) {
    if (c.action === "create") added++;
    else if (c.action === "delete") deleted++;
    else modified++;
    // Rough line count from content
    var newLen = (c.content || "").split("\\n").length;
    if (c.action === "create") linesAdded += newLen;
    else if (c.action === "delete") linesDeleted += newLen;
  });
  return { added: added, modified: modified, deleted: deleted, linesAdded: linesAdded, linesDeleted: linesDeleted };
}

// U2: Collapse consecutive unchanged lines (> 500)
var COLLAPSE_THRESHOLD = 500;
// expandedCollapseKeys tracks which collapsed sections the user expanded
var expandedCollapseKeys = {};

function collapseUnchangedRows(diffResult) {
  // Walk diff result, find runs of consecutive "ctx" lines > COLLAPSE_THRESHOLD
  var output = [];
  var ctxRun = [];
  function flushCtx() {
    if (ctxRun.length > COLLAPSE_THRESHOLD) {
      // Keep first 3 and last 3 context lines, collapse the rest
      var collapseKey = "collapse-" + ctxRun[0].oldNum;
      if (expandedCollapseKeys[collapseKey]) {
        output.push.apply(output, ctxRun);
      } else {
        for (var k = 0; k < 3; k++) output.push(ctxRun[k]);
        output.push({ type: "collapse", count: ctxRun.length - 6, collapseKey: collapseKey });
        for (var k = ctxRun.length - 3; k < ctxRun.length; k++) output.push(ctxRun[k]);
      }
    } else {
      output.push.apply(output, ctxRun);
    }
    ctxRun = [];
  }
  for (var i = 0; i < diffResult.length; i++) {
    if (diffResult[i].type === "ctx") {
      ctxRun.push(diffResult[i]);
    } else {
      if (ctxRun.length > 0) flushCtx();
      output.push(diffResult[i]);
    }
  }
  if (ctxRun.length > 0) flushCtx();
  return output;
}

function expandCollapse(key) {
  expandedCollapseKeys[key] = true;
  renderReviewPanel();
}

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── Word-level diff (LCS on words) ──────────────────────────────
function computeWordDiff(oldText, newText) {
  var oldWords = oldText.split(/(\s+)/);
  var newWords = newText.split(/(\s+)/);
  if (oldWords.length > 400 || newWords.length > 400) return null; // perf guard
  var n = oldWords.length, m = newWords.length;
  var dp = [];
  for (var i = 0; i <= n; i++) { dp[i] = new Uint16Array(m + 1); }
  for (var i = 1; i <= n; i++) {
    for (var j = 1; j <= m; j++) {
      if (oldWords[i-1] === newWords[j-1]) dp[i][j] = dp[i-1][j-1] + 1;
      else dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
    }
  }
  var result = [];
  var i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i-1] === newWords[j-1]) {
      result.push({ type: "eq", text: oldWords[i-1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      result.push({ type: "add", text: newWords[j-1] }); j--;
    } else {
      result.push({ type: "del", text: oldWords[i-1] }); i--;
    }
  }
  result.reverse();
  return result;
}

function renderCharDiffHtml(line, pairedLine, side) {
  if (!pairedLine) return escHtml(line);
  var oldText = side === "del" ? line : pairedLine;
  var newText = side === "add" ? line : pairedLine;
  var wd = computeWordDiff(oldText, newText);
  if (!wd) return escHtml(line);
  var html = "";
  for (var k = 0; k < wd.length; k++) {
    var w = wd[k];
    if (w.type === "eq") { html += escHtml(w.text); }
    else if (w.type === "del" && side === "del") { html += '<span class="char-del">' + escHtml(w.text) + '</span>'; }
    else if (w.type === "add" && side === "add") { html += '<span class="char-add">' + escHtml(w.text) + '</span>'; }
  }
  return html;
}

function getLineKey(d) {
  if (d.type === "add") return "add-" + d.newNum;
  if (d.type === "del") return "del-" + d.oldNum;
  return "ctx-" + d.oldNum + "-" + d.newNum;
}

function setDiffMode(mode) {
  diffMode = mode;
  localStorage.setItem("diffMode", mode);
  document.getElementById("btnUnified").className = "diff-mode-btn" + (mode === "unified" ? " active" : "");
  document.getElementById("btnSplit").className = "diff-mode-btn" + (mode === "split" ? " active" : "");
  renderReviewPanel();
}

function renderSplitDiffTable(oldContent, newContent, isCreate) {
  var table = document.getElementById("diffTable");
  table.className = "diff-table split-mode";
  if (isCreate) {
    var lines = (newContent || "").split("\\n");
    table.innerHTML = lines.map(function(line, i) {
      var lk = "add-" + (i+1);
      var fp = getCurrentFilePath();
      var commentHtml = renderLineComments(fp, lk);
      var formHtml = openCommentForms.hasOwnProperty(lk) ? renderCommentForm(fp, lk) : "";
      return '<tr class="split-line-empty">' +
        '<td class="comment-trigger" tabindex="0" role="button" aria-label="Add comment on line ' + (i+1) + '" onclick="toggleCommentForm(\\''+lk+'\\')" onkeydown="if(event.key===\\'Enter\\')toggleCommentForm(\\''+lk+'\\')">+</td>' +
        '<td class="line-num"></td><td class="line-content-split"></td>' +
        '<td class="split-gutter"></td>' +
        '<td class="line-num">' + (i+1) + '</td>' +
        '<td class="line-content-split" style="color:var(--green)">' + escHtml(line) + '</td>' +
      '</tr>' + commentHtml + formHtml;
    }).join("");
    return;
  }
  var oldLines = (oldContent || "").replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n").split("\\n");
  var newLines = (newContent || "").replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n").split("\\n");
  var diff = computeDiff(oldLines, newLines);
  // U2: Collapse unchanged lines
  diff = collapseUnchangedRows(diff);
  // Group consecutive del/add for pairing
  var rows = [];
  var i = 0;
  while (i < diff.length) {
    if (diff[i].type === "collapse") {
      rows.push({ type: "collapse", count: diff[i].count, collapseKey: diff[i].collapseKey });
      i++;
    } else if (diff[i].type === "ctx") {
      rows.push({ type: "ctx", old: diff[i], new: diff[i] });
      i++;
    } else {
      var dels = [], adds = [];
      while (i < diff.length && diff[i].type === "del") { dels.push(diff[i]); i++; }
      while (i < diff.length && diff[i].type === "add") { adds.push(diff[i]); i++; }
      var maxLen = Math.max(dels.length, adds.length);
      for (var k = 0; k < maxLen; k++) {
        rows.push({ type: "pair", old: dels[k] || null, new: adds[k] || null });
      }
    }
  }
  var fp = getCurrentFilePath();
  table.innerHTML = rows.map(function(r) {
    if (r.type === "collapse") {
      return '<tr class="diff-collapse-row" onclick="expandCollapse(\\'' + r.collapseKey + '\\')">' +
        '<td colspan="6">... ' + r.count + ' unchanged lines ...</td></tr>';
    }
    if (r.type === "ctx") {
      var lk = getLineKey(r.old);
      var commentHtml = renderLineComments(fp, lk);
      var formHtml = openCommentForms.hasOwnProperty(lk) ? renderCommentForm(fp, lk) : "";
      return '<tr class="split-line-ctx">' +
        '<td class="comment-trigger" tabindex="0" role="button" aria-label="Add comment on line ' + r.old.oldNum + '" onclick="toggleCommentForm(\\''+lk+'\\')" onkeydown="if(event.key===\\'Enter\\')toggleCommentForm(\\''+lk+'\\')">+</td>' +
        '<td class="line-num">' + r.old.oldNum + '</td>' +
        '<td class="line-content-split">' + escHtml(r.old.text) + '</td>' +
        '<td class="split-gutter"></td>' +
        '<td class="line-num">' + r.new.newNum + '</td>' +
        '<td class="line-content-split">' + escHtml(r.new.text) + '</td>' +
      '</tr>' + commentHtml + formHtml;
    }
    // pair row
    var oldD = r.old, newD = r.new;
    var lCls = oldD ? "split-line-del" : "split-line-empty";
    var rCls = newD ? "split-line-add" : "split-line-empty";
    var lNum = oldD ? oldD.oldNum : "";
    var rNum = newD ? newD.newNum : "";
    var lText = oldD ? (newD ? renderCharDiffHtml(oldD.text, newD.text, "del") : escHtml(oldD.text)) : "";
    var rText = newD ? (oldD ? renderCharDiffHtml(newD.text, oldD.text, "add") : escHtml(newD.text)) : "";
    var lk = oldD ? getLineKey(oldD) : (newD ? getLineKey(newD) : "");
    var commentHtml = renderLineComments(fp, lk);
    var formHtml = openCommentForms.hasOwnProperty(lk) ? renderCommentForm(fp, lk) : "";
    var lineLabel = lNum || rNum || "";
    return '<tr>' +
      '<td class="comment-trigger" tabindex="0" role="button" aria-label="Add comment on line ' + lineLabel + '" onclick="toggleCommentForm(\\''+lk+'\\')" onkeydown="if(event.key===\\'Enter\\')toggleCommentForm(\\''+lk+'\\')">+</td>' +
      '<td class="line-num ' + lCls + '">' + lNum + '</td>' +
      '<td class="line-content-split ' + lCls + '">' + lText + '</td>' +
      '<td class="split-gutter"></td>' +
      '<td class="line-num ' + rCls + '">' + rNum + '</td>' +
      '<td class="line-content-split ' + rCls + '">' + rText + '</td>' +
    '</tr>' + commentHtml + formHtml;
  }).join("");
}

function getCurrentFilePath() {
  if (!reviewData) return "";
  var changes = reviewData.changes || [];
  var file = changes[reviewFileIdx] || changes[0];
  return file ? file.file_path : "";
}

function renderLineComments(filePath, lineKey) {
  if (!filePath || !lineKey) return "";
  var fileComments = reviewLineComments[filePath];
  if (!fileComments || !fileComments[lineKey] || fileComments[lineKey].length === 0) return "";
  var colSpan = diffMode === "split" ? 6 : 5;
  return fileComments[lineKey].map(function(c) {
    var time = new Date(c.timestamp).toLocaleTimeString();
    return '<tr class="inline-comment-row"><td colspan="' + colSpan + '">' +
      '<div class="inline-comment-display">' + escHtml(c.text) +
      '<span class="comment-time">' + time + '</span></div></td></tr>';
  }).join("");
}

function renderCommentForm(filePath, lineKey) {
  var colSpan = diffMode === "split" ? 6 : 5;
  // U4: Restore draft text if available
  var draft = openCommentForms[lineKey] || "";
  return '<tr class="inline-comment-row"><td colspan="' + colSpan + '">' +
    '<div class="inline-comment-form">' +
    '<textarea id="commentInput_' + lineKey + '" placeholder="Add a review comment..." oninput="saveDraftComment(\\'' + lineKey + '\\', this.value)">' + escHtml(draft) + '</textarea>' +
    '<div class="comment-btns">' +
    '<button class="btn-add-comment" onclick="addLineComment(\\'' + escHtml(filePath).replace(/'/g, "\\\\'") + '\\', \\'' + lineKey + '\\')">Add Comment</button>' +
    '<button class="btn-cancel-comment" onclick="closeCommentForm(\\'' + lineKey + '\\')">Cancel</button>' +
    '</div></div></td></tr>';
}

// U4: Save draft text for a comment form + persist to localStorage
var _commentDraftTimer = null;
function saveDraftComment(lineKey, text) {
  openCommentForms[lineKey] = text;
  // Debounce localStorage persistence at 500ms
  if (_commentDraftTimer) clearTimeout(_commentDraftTimer);
  _commentDraftTimer = setTimeout(function() {
    persistInlineCommentDrafts();
  }, 500);
}

function _inlineCommentDraftKey() {
  return "mi-dev-agent-comment-drafts_" + _getDraftTicketId();
}

function persistInlineCommentDrafts() {
  try {
    var draftKey = _inlineCommentDraftKey();
    var drafts = {};
    for (var key in openCommentForms) {
      if (openCommentForms[key] && openCommentForms[key].trim()) {
        drafts[key] = openCommentForms[key];
      }
    }
    if (Object.keys(drafts).length > 0) {
      localStorage.setItem(draftKey, JSON.stringify(drafts));
    } else {
      localStorage.removeItem(draftKey);
    }
  } catch {}
}

function restoreInlineCommentDrafts() {
  try {
    var raw = localStorage.getItem(_inlineCommentDraftKey());
    if (!raw) return false;
    var drafts = JSON.parse(raw);
    if (!drafts || Object.keys(drafts).length === 0) return false;
    for (var key in drafts) {
      openCommentForms[key] = drafts[key];
    }
    return true;
  } catch { return false; }
}

function clearInlineCommentDrafts() {
  try { localStorage.removeItem(_inlineCommentDraftKey()); } catch {}
}

function addLineComment(filePath, lineKey) {
  var input = document.getElementById("commentInput_" + lineKey);
  if (!input) return;
  var text = input.value.trim();
  if (!text) return;
  if (!reviewLineComments[filePath]) reviewLineComments[filePath] = {};
  if (!reviewLineComments[filePath][lineKey]) reviewLineComments[filePath][lineKey] = [];
  reviewLineComments[filePath][lineKey].push({ text: text, timestamp: Date.now() });
  // U4: Remove this form from open forms map and clear persisted draft
  delete openCommentForms[lineKey];
  persistInlineCommentDrafts();
  persistComments(); // U1: Save to server
  renderReviewPanel();
}

// U4: Toggle opens/closes a single form without affecting others
function toggleCommentForm(lineKey) {
  if (openCommentForms.hasOwnProperty(lineKey)) {
    delete openCommentForms[lineKey];
  } else {
    openCommentForms[lineKey] = "";
  }
  renderReviewPanel();
}

// U4: Close a specific comment form
function closeCommentForm(lineKey) {
  delete openCommentForms[lineKey];
  renderReviewPanel();
}

function getCommentCountForFile(filePath) {
  var fileComments = reviewLineComments[filePath];
  if (!fileComments) return 0;
  var count = 0;
  for (var key in fileComments) { count += fileComments[key].length; }
  return count;
}

function collectAllComments() {
  var parts = [];
  for (var fp in reviewLineComments) {
    var fileComments = reviewLineComments[fp];
    var fileLines = [];
    for (var lk in fileComments) {
      fileComments[lk].forEach(function(c) {
        fileLines.push("  [" + lk + "] " + c.text);
      });
    }
    if (fileLines.length > 0) {
      parts.push(fp + ":\\n" + fileLines.join("\\n"));
    }
  }
  return parts.length > 0 ? "\\n\\n--- Inline Review Comments ---\\n" + parts.join("\\n\\n") : "";
}

function renderDiffTable(oldContent, newContent, isCreate) {
  var table = document.getElementById("diffTable");
  table.className = "diff-table";
  // Split mode delegation
  if (diffMode === "split") {
    return renderSplitDiffTable(oldContent, newContent, isCreate);
  }
  var fp = getCurrentFilePath();
  if (isCreate) {
    var lines = (newContent || "").split("\\n");
    table.innerHTML = lines.map(function(line, i) {
      var lk = "add-" + (i+1);
      var commentHtml = renderLineComments(fp, lk);
      var formHtml = openCommentForms.hasOwnProperty(lk) ? renderCommentForm(fp, lk) : "";
      return '<tr class="diff-line-add">' +
        '<td class="comment-trigger" onclick="toggleCommentForm(\\''+lk+'\\')">+</td>' +
        '<td class="line-num"></td>' +
        '<td class="line-num">' + (i + 1) + '</td>' +
        '<td class="line-prefix">+</td>' +
        '<td class="line-content">' + escHtml(line) + '</td>' +
      '</tr>' + commentHtml + formHtml;
    }).join("");
    return;
  }
  var oldLines = (oldContent || "").replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n").split("\\n");
  var newLines = (newContent || "").replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n").split("\\n");
  var diff = computeDiff(oldLines, newLines);
  // U2: Collapse unchanged lines
  diff = collapseUnchangedRows(diff);
  // Pair consecutive del/add runs for char-level highlighting
  var pairMap = {};
  var i = 0;
  while (i < diff.length) {
    if (diff[i].type === "del") {
      var dels = [], adds = [];
      var startIdx = i;
      while (i < diff.length && diff[i].type === "del") { dels.push(i); i++; }
      while (i < diff.length && diff[i].type === "add") { adds.push(i); i++; }
      var pairLen = Math.min(dels.length, adds.length);
      for (var k = 0; k < pairLen; k++) {
        pairMap[dels[k]] = adds[k];
        pairMap[adds[k]] = dels[k];
      }
    } else { i++; }
  }
  table.innerHTML = diff.map(function(d, idx) {
    // U2: Collapse row
    if (d.type === "collapse") {
      return '<tr class="diff-collapse-row" onclick="expandCollapse(\\'' + d.collapseKey + '\\')">' +
        '<td colspan="5">... ' + d.count + ' unchanged lines ...</td></tr>';
    }
    var cls = d.type === "add" ? "diff-line-add" : d.type === "del" ? "diff-line-del" : "diff-line-ctx";
    // Accessibility: non-color text prefix with symbol indicators for colorblind users
    var a11yPrefix = d.type === "add" ? "\\u2713" : d.type === "del" ? "\\u2717" : " ";
    var oNum = d.oldNum || "";
    var nNum = d.newNum || "";
    var lk = getLineKey(d);
    // Char-level highlighting for paired lines
    var contentHtml;
    if (pairMap[idx] !== undefined) {
      var pairedD = diff[pairMap[idx]];
      contentHtml = renderCharDiffHtml(d.text, pairedD.text, d.type);
    } else {
      contentHtml = escHtml(d.text);
    }
    var commentHtml = renderLineComments(fp, lk);
    var formHtml = openCommentForms.hasOwnProperty(lk) ? renderCommentForm(fp, lk) : "";
    return '<tr class="' + cls + '">' +
      '<td class="comment-trigger" tabindex="0" role="button" aria-label="Add comment on line ' + (oNum || nNum) + '" onclick="toggleCommentForm(\\''+lk+'\\')" onkeydown="if(event.key===\\'Enter\\')toggleCommentForm(\\''+lk+'\\')">+</td>' +
      '<td class="line-num">' + oNum + '</td>' +
      '<td class="line-num">' + nNum + '</td>' +
      '<td class="line-prefix" aria-hidden="true">' + a11yPrefix + '</td>' +
      '<td class="line-content">' + contentHtml + '</td>' +
    '</tr>' + commentHtml + formHtml;
  }).join("");
}

function formatPlan(text) {
  var s = escHtml(text);
  // Y1: Escape capture groups before insertion to prevent XSS
  s = s.replace(/^## (.+)$/gm, function(m, g1) { return '<div style="font-size:14px;font-weight:700;color:var(--blue);margin:14px 0 6px">' + escHtml(g1) + '</div>'; });
  s = s.replace(/^### (.+)$/gm, function(m, g1) { return '<div style="font-size:13px;font-weight:600;color:var(--text);margin:10px 0 4px">' + escHtml(g1) + '</div>'; });
  s = s.replace(/\*\*(.+?)\*\*/g, function(m, g1) { return '<strong style="color:var(--text)">' + escHtml(g1) + '</strong>'; });
  var tick = String.fromCharCode(96);
  var codeRe = new RegExp(tick + '([^' + tick + ']+)' + tick, 'g');
  s = s.replace(codeRe, function(m, g1) { return '<code style="background:var(--bg);padding:1px 5px;border-radius:3px;color:var(--green)">' + escHtml(g1) + '</code>'; });
  s = s.replace(/^[\\u2022\\-\\*] (.+)$/gm, function(m, g1) { return '<div style="padding-left:16px">- ' + escHtml(g1) + '</div>'; });
  s = s.replace(/\\n/g, '<br>');
  return s;
}

// ── Tabbed Plan Viewer ──────────────────────────────────────────
var activePlanTab = "proposal";

function renderPlanTabs(os) {
  var tabsEl = document.getElementById("planTabs");
  var contentEl = document.getElementById("planTabContent");
  var sugEl = document.getElementById("planSuggestions");
  var summaryEl = document.getElementById("planSummary");

  // Render summary overview with artifact stats
  var stats = [];
  if (os.design) {
    var dMatch = os.design.match(/\\bD\\d+/g);
    stats.push('<span class="plan-stat"><span class="plan-stat-num">' + (dMatch ? dMatch.length : '-') + '</span> Design Decisions</span>');
  }
  if (os.specs) {
    var sLines = (os.specs.match(/WHEN\\b/gi) || []).length;
    var reqLines = (os.specs.match(/^\\s*[-*]\\s*(ADDED|MODIFIED|REMOVED)/gm) || []).length;
    stats.push('<span class="plan-stat"><span class="plan-stat-num">' + (reqLines || '-') + '</span> Requirements</span>');
    stats.push('<span class="plan-stat"><span class="plan-stat-num">' + (sLines || '-') + '</span> WHEN/THEN Scenarios</span>');
  }
  if (os.tasks) {
    var taskCheckboxes = (os.tasks.match(/^\\s*[-*]\\s*\\[[ x]\\]/gm) || []).length;
    var taskGroups = (os.tasks.match(/^#+\\s/gm) || []).length;
    stats.push('<span class="plan-stat"><span class="plan-stat-num">' + (taskGroups || '-') + '</span> Task Groups</span>');
    stats.push('<span class="plan-stat"><span class="plan-stat-num">' + (taskCheckboxes || '-') + '</span> Tasks</span>');
  }
  if (stats.length > 0) {
    summaryEl.style.display = "";
    summaryEl.innerHTML = '<div class="plan-summary-title">Implementation Plan (OpenSpec)</div>' +
      '<div class="plan-summary-stats">' + stats.join("") + '</div>';
  } else {
    summaryEl.style.display = "none";
  }

  var tabs = [
    { id: "proposal", label: "Proposal", content: os.proposal || "" },
    { id: "design", label: "Design", content: os.design || "" },
    { id: "specs", label: "Specs", content: os.specs || "" },
    { id: "tasks", label: "Tasks", content: os.tasks || "" },
  ];

  // Render tab buttons
  tabsEl.innerHTML = tabs.map(function(t) {
    var cls = t.id === activePlanTab ? " active" : "";
    var hasContent = t.content.length > 0;
    return '<button class="plan-tab' + cls + '" data-tab="' + t.id + '" onclick="switchPlanTab(\\'' + t.id + '\\')"' +
      (hasContent ? '' : ' style="opacity:0.4"') +
      '>' + t.label + '</button>';
  }).join("");

  // Render active tab content
  var activeTab = tabs.find(function(t) { return t.id === activePlanTab; });
  var content = activeTab ? activeTab.content : "(No content)";
  contentEl.innerHTML = content ? formatPlan(content) : '<div style="color:var(--text3);font-style:italic">No content for this artifact.</div>';

  // Render suggestions
  var suggestions = os.suggestions || [];
  if (suggestions.length > 0) {
    sugEl.style.display = "";
    sugEl.innerHTML = '<div class="sug-title">Agent Suggestions</div>' +
      suggestions.map(function(s) {
        return '<div class="sug-item">' + escHtml(s) + '</div>';
      }).join("");
  } else {
    sugEl.style.display = "none";
  }
}

function switchPlanTab(tabId) {
  activePlanTab = tabId;
  if (reviewData && reviewData.openspec) {
    renderPlanTabs(reviewData.openspec);
  }
}

// ── Refine Form ─────────────────────────────────────────────────
function showRefineForm() {
  document.getElementById("refineFeedback").className = "visible";
  document.getElementById("rejectFeedback").className = "";
}

async function submitRefine() {
  if (!reviewData || !reviewData.gate) return;
  var ticket = document.getElementById("ticket").value.trim() || "";
  var gate = GATE_STAGES[reviewData.gate] || reviewData.gate;
  var instructions = document.getElementById("refineText").value.trim();
  if (!instructions) return showToast("Please provide refinement instructions", "error");
  var btnR = document.getElementById("btnRefine");
  var btnA = document.getElementById("btnApprove");
  var btnRej = document.getElementById("btnReject");
  setButtonLoading(btnR, true, "Refining...");
  btnA.disabled = true;
  btnRej.disabled = true;
  try {
    await authPost("/api/refine", { ticket: ticket, gate: gate, instructions: instructions });
    document.getElementById("reviewStatus").textContent = "Refining plan...";
    document.getElementById("reviewStatus").style.color = "var(--purple)";
    document.getElementById("refineFeedback").className = "";
    document.getElementById("refineText").value = "";
    formDrafts.clear("refineText");
    showToast("Refinement requested \\u2014 agents will re-run with your instructions", "info");
    btnR.classList.remove("btn-loading");
    btnR.textContent = "Refine";
  } catch (e) {
    showToast("Refine failed: " + e.message, "error");
    setButtonLoading(btnR, false, "Refine");
    btnA.disabled = false;
    btnRej.disabled = false;
  }
}

function renderReviewPanel() {
  const panel = document.getElementById("reviewPanel");
  const planEl = document.getElementById("planViewer");
  const diffEl = document.getElementById("diffViewer");
  const qaEl = document.getElementById("qaViewer");
  const mrEl = document.getElementById("mrViewer");
  const badge = document.getElementById("gateBadge");
  const statusEl = document.getElementById("reviewStatus");

  // Hide all viewers
  planEl.className = ""; diffEl.className = ""; qaEl.className = ""; mrEl.className = "";
  document.getElementById("planSummary").style.display = "none";
  panel.className = "";
  statusEl.textContent = "";
  document.getElementById("diffToolbar").style.display = "none";
  document.getElementById("diffInfo").innerHTML = "";
  document.getElementById("diffStats").innerHTML = "";
  document.getElementById("diffFileSearch").style.display = "none";
  document.getElementById("diffFileLabel").innerHTML = "";

  // Reset buttons to default state
  var btnApprove = document.getElementById("btnApprove");
  var btnReject = document.getElementById("btnReject");
  var btnRefine = document.getElementById("btnRefine");
  btnApprove.textContent = "Approve";
  btnApprove.disabled = false;
  btnReject.style.display = "";
  btnReject.disabled = false;
  btnRefine.style.display = "none";
  btnRefine.disabled = false;
  document.getElementById("refineFeedback").className = "";

  if (!reviewData || !reviewData.gate) return;

  panel.className = "visible review-panel-enter";

  if (reviewData.gate === "explore_plan") {
    badge.textContent = "Plan Review";
    planEl.className = "visible";
    // Show Refine button for explore_plan gate
    document.getElementById("btnRefine").style.display = "";

    var os = reviewData.openspec;
    if (os && (os.proposal || os.design || os.specs || os.tasks)) {
      // Tabbed OpenSpec plan viewer
      renderPlanTabs(os);
    } else {
      // Fallback: simple plan display
      document.getElementById("planSummary").style.display = "none";
      document.getElementById("planTabs").innerHTML = "";
      document.getElementById("planTabContent").innerHTML = formatPlan(reviewData.plan || "(No plan data)");
      document.getElementById("planSuggestions").style.display = "none";
    }
  }

  else if (reviewData.gate === "gate_code_review") {
    badge.textContent = "Code Review";
    diffEl.className = "visible";
    const changes = reviewData.changes || [];
    const origFiles = reviewData.original_files || {};

    // U7: File stats
    renderDiffStatsBar(changes);

    // U6: File search (show when > 5 files)
    if (changes.length > 5) document.getElementById("diffFileSearch").style.display = "";

    // U6: Filter files by search
    var filteredChanges = changes;
    var filteredIndices = changes.map(function(_, i) { return i; });
    if (diffFileFilter) {
      filteredIndices = [];
      filteredChanges = changes.filter(function(c, i) {
        var match = c.file_path.toLowerCase().indexOf(diffFileFilter) !== -1;
        if (match) filteredIndices.push(i);
        return match;
      });
      document.getElementById("diffSearchCount").textContent = filteredChanges.length + " of " + changes.length + " files";
    } else {
      document.getElementById("diffSearchCount").textContent = "";
    }

    // Y3: Render file tabs with ARIA roles + comment count badges
    var tabs = document.getElementById("diffFileTabs");
    tabs.innerHTML = filteredChanges.map(function(c, fi) {
      var realIdx = filteredIndices[fi];
      var name = c.file_path.split("/").pop();
      var isActive = realIdx === reviewFileIdx;
      var cls = isActive ? " active" : "";
      var cCount = getCommentCountForFile(c.file_path);
      var badgeHtml = cCount > 0 ? ' <span class="comment-count-badge">' + cCount + '</span>' : "";
      return '<button class="diff-file-tab' + cls + '" role="tab" aria-selected="' + isActive + '" onclick="selectDiffFile(' + realIdx + ')" title="' + escHtml(c.file_path) + '">' +
        '<span class="action-badge ' + c.action + '">' + c.action + '</span>' +
        escHtml(name) + badgeHtml +
        '<span class="copy-btn" onclick="event.stopPropagation();copyToClipboard(\\'' + escHtml(c.file_path).replace(/'/g, "\\\\'") + '\\')" title="Copy path">&#x2398;</span>' +
      '</button>';
    }).join("");

    document.getElementById("diffToolbar").style.display = "";
    document.getElementById("btnUnified").className = "diff-mode-btn" + (diffMode === "unified" ? " active" : "");
    document.getElementById("btnSplit").className = "diff-mode-btn" + (diffMode === "split" ? " active" : "");

    // Show diff progress for multiple files
    if (changes.length > 5) {
      showDiffProgress(reviewFileIdx + 1, changes.length);
    } else {
      hideDiffProgress();
    }

    // Render diff for selected file
    if (changes.length > 0) {
      var file = changes[reviewFileIdx] || changes[0];
      var isCreate = file.action === "create";
      var isDelete = file.action === "delete";
      var origContent = origFiles[file.file_path] || "";

      // Large file warning
      var lineCount = (file.content || "").split("\\n").length + (origContent || "").split("\\n").length;
      showLargeFileWarning(lineCount);

      // Y12: New/Deleted file labels
      renderFileLabel(file.action);

      // U10: Binary file detection
      if (isBinaryContent(file.content) || isBinaryContent(origContent)) {
        var table = document.getElementById("diffTable");
        var sz = (file.content || "").length;
        table.innerHTML = '<tr><td colspan="5"><div class="binary-placeholder">[Binary file: ' + escHtml(file.file_path.split("/").pop()) + ', ' + sz + ' bytes]</div></td></tr>';
      } else {
        renderDiffTable(origContent, file.content, isCreate);
      }
    }

    // Show summary + test notes (Y14: safeHref)
    var infoEl = document.getElementById("diffInfo");
    var info = "";
    if (reviewData.summary) info += '<div style="margin-top:12px;font-size:13px;color:var(--text2)"><strong>Summary:</strong> ' + escHtml(reviewData.summary) + '</div>';
    if (reviewData.test_notes) info += '<div style="margin-top:6px;font-size:13px;color:var(--text2)"><strong>Test notes:</strong> ' + escHtml(reviewData.test_notes) + '</div>';
    if (reviewData.mr_url) info += '<div style="margin-top:6px"><a href="' + safeHref(reviewData.mr_url) + '" target="_blank" rel="noopener" class="mr-link">Open GitLab MR</a> <span class="copy-btn" onclick="copyToClipboard(\\'' + escHtml(reviewData.mr_url).replace(/'/g, "\\\\'") + '\\')" title="Copy MR URL" style="display:inline-flex;vertical-align:middle">&#x2398;</span></div>';
    infoEl.innerHTML = info;
  }

  else if (reviewData.gate === "deploy_qa") {
    badge.textContent = "Merge to QA";
    diffEl.className = "visible";
    var changes = reviewData.changes || [];
    var origFiles = reviewData.original_files || {};

    // U7: File stats
    renderDiffStatsBar(changes);

    // U6: File search
    if (changes.length > 5) document.getElementById("diffFileSearch").style.display = "";
    var filteredChanges = changes;
    var filteredIndices = changes.map(function(_, i) { return i; });
    if (diffFileFilter) {
      filteredIndices = [];
      filteredChanges = changes.filter(function(c, i) {
        var match = c.file_path.toLowerCase().indexOf(diffFileFilter) !== -1;
        if (match) filteredIndices.push(i);
        return match;
      });
      document.getElementById("diffSearchCount").textContent = filteredChanges.length + " of " + changes.length + " files";
    } else {
      document.getElementById("diffSearchCount").textContent = "";
    }

    // Y3: File tabs with ARIA
    var tabs = document.getElementById("diffFileTabs");
    tabs.innerHTML = filteredChanges.map(function(c, fi) {
      var realIdx = filteredIndices[fi];
      var name = c.file_path.split("/").pop();
      var isActive = realIdx === reviewFileIdx;
      var cls = isActive ? " active" : "";
      var cCount = getCommentCountForFile(c.file_path);
      var badgeHtml = cCount > 0 ? ' <span class="comment-count-badge">' + cCount + '</span>' : "";
      return '<button class="diff-file-tab' + cls + '" role="tab" aria-selected="' + isActive + '" onclick="selectDiffFile(' + realIdx + ')" title="' + escHtml(c.file_path) + '">' +
        '<span class="action-badge ' + c.action + '">' + c.action + '</span>' +
        escHtml(name) + badgeHtml +
        '<span class="copy-btn" onclick="event.stopPropagation();copyToClipboard(\\'' + escHtml(c.file_path).replace(/'/g, "\\\\'") + '\\')" title="Copy path">&#x2398;</span>' +
      '</button>';
    }).join("");

    document.getElementById("diffToolbar").style.display = "";
    document.getElementById("btnUnified").className = "diff-mode-btn" + (diffMode === "unified" ? " active" : "");
    document.getElementById("btnSplit").className = "diff-mode-btn" + (diffMode === "split" ? " active" : "");

    if (changes.length > 0) {
      var file = changes[reviewFileIdx] || changes[0];
      var isCreate = file.action === "create";
      var origContent = origFiles[file.file_path] || "";

      renderFileLabel(file.action);

      if (isBinaryContent(file.content) || isBinaryContent(origContent)) {
        var table = document.getElementById("diffTable");
        var sz = (file.content || "").length;
        table.innerHTML = '<tr><td colspan="5"><div class="binary-placeholder">[Binary file: ' + escHtml(file.file_path.split("/").pop()) + ', ' + sz + ' bytes]</div></td></tr>';
      } else {
        renderDiffTable(origContent, file.content, isCreate);
      }
    }

    // MR link + instructions (Y14: safeHref)
    var infoEl = document.getElementById("diffInfo");
    var infoHtml = '<div style="margin-top:12px;padding:12px;background:var(--bg);border-radius:8px;border:1px solid var(--border)">';
    infoHtml += '<div style="font-size:13px;color:var(--cyan);font-weight:600;margin-bottom:8px">Review the changes above before merging to enterprise-qa</div>';
    infoHtml += '<div style="font-size:13px;color:var(--text2)">Click <strong>Approve & Merge</strong> to merge into QA, or <strong>Reject</strong> to send back for regeneration.</div>';
    if (reviewData.mr_url) infoHtml += '<div style="margin-top:8px"><a href="' + safeHref(reviewData.mr_url) + '" target="_blank" rel="noopener" class="mr-link" style="font-size:14px">Open MR on GitLab</a></div>';
    infoHtml += '</div>';
    if (reviewData.summary) infoHtml += '<div style="margin-top:8px;font-size:13px;color:var(--text2)"><strong>Summary:</strong> ' + escHtml(reviewData.summary) + '</div>';
    infoEl.innerHTML = infoHtml;

    document.getElementById("btnApprove").textContent = "Approve & Merge";
  }

  else if (reviewData.gate === "gate_preprod_approval") {
    badge.textContent = "QA Results";
    qaEl.className = "visible";
    var tests = reviewData.qa_test || [];
    qaEl.innerHTML = tests.map(function(t) {
      return '<div class="qa-row">' +
        '<span class="qa-badge ' + (t.ok ? "pass" : "fail") + '">' + (t.ok ? "PASS" : "FAIL") + '</span>' +
        '<span>' + escHtml(t.name || "") + '</span>' +
        '<span style="color:var(--text3);font-size:11px;margin-left:auto">' + escHtml(t.env || "") + '</span>' +
      '</div>';
    }).join("") +
    (reviewData.mr_url ? '<div style="margin-top:12px"><a href="' + safeHref(reviewData.mr_url) + '" target="_blank" rel="noopener" class="mr-link">Open GitLab MR</a></div>' : '');
  }

  else if (reviewData.gate === "gate_dual_approval") {
    badge.textContent = "Dual Approval";
    mrEl.className = "visible";
    mrEl.innerHTML =
      (reviewData.preprod_mr_url ? '<a href="' + safeHref(reviewData.preprod_mr_url) + '" target="_blank" rel="noopener" class="mr-link">Open Pre-Prod MR</a>' : '') +
      '<div class="mr-summary">' + escHtml(reviewData.summary || "") + '</div>';
  }
}

// U7: Render diff stats bar
function renderDiffStatsBar(changes) {
  var stats = computeDiffStats(changes);
  var el = document.getElementById("diffStats");
  var parts = [];
  if (stats.added) parts.push('<span class="stat-added">' + stats.added + ' added</span>');
  if (stats.modified) parts.push('<span class="stat-modified">' + stats.modified + ' modified</span>');
  if (stats.deleted) parts.push('<span class="stat-deleted">' + stats.deleted + ' deleted</span>');
  parts.push('<span class="stat-lines">+' + stats.linesAdded + ' / -' + stats.linesDeleted + ' lines</span>');
  el.innerHTML = parts.join(' &middot; ');
}

// Y12: File label for new/deleted files
function renderFileLabel(action) {
  var el = document.getElementById("diffFileLabel");
  if (action === "create") {
    el.innerHTML = '<span class="diff-file-label new-file">New file</span>';
  } else if (action === "delete") {
    el.innerHTML = '<span class="diff-file-label deleted-file">File deleted</span>';
  } else {
    el.innerHTML = "";
  }
}

function selectDiffFile(idx) {
  reviewFileIdx = idx;
  renderReviewPanel();
}

var _fetchReviewInProgress = false;
async function fetchReview() {
  if (_fetchReviewInProgress) return; // Prevent concurrent fetches
  _fetchReviewInProgress = true;
  try {
    const ticket = document.getElementById("ticket").value.trim() || "";
    // Show loading state if no review data yet
    if (!reviewData || !reviewData.gate) {
      var panel = document.getElementById("reviewPanel");
      // Only show loading if panel would be visible (stage requires it)
      if (currentStage && GATE_STAGES[currentStage]) {
        showReviewLoading();
      }
    }
    const res = await fetchWithTimeout("/api/review?ticket=" + encodeURIComponent(ticket));
    const data = await res.json();
    const hadGate = reviewData && reviewData.gate;
    reviewData = data;
    // Reset file index when gate changes
    if (!hadGate || hadGate !== data.gate) reviewFileIdx = 0;
    renderReviewPanel();
    onFetchSuccess();
  } catch { onFetchError(); }
  _fetchReviewInProgress = false;
}

function showRejectForm() {
  document.getElementById("refineFeedback").className = "";
  document.getElementById("rejectFeedback").className = "visible";
  var totalComments = 0;
  for (var fp in reviewLineComments) { totalComments += getCommentCountForFile(fp); }
  var ta = document.getElementById("rejectText");
  if (totalComments > 0) {
    ta.placeholder = totalComments + " inline comment(s) will be included. Add additional feedback or leave empty...";
  } else {
    ta.placeholder = "Describe what needs to change...";
  }
}

// U9: Double-submit prevention
async function approveGate() {
  if (!reviewData || !reviewData.gate) return;
  const ticket = document.getElementById("ticket").value.trim() || "";
  const gate = GATE_STAGES[reviewData.gate] || reviewData.gate;
  const btnA = document.getElementById("btnApprove");
  const btnR = document.getElementById("btnReject");
  const isDeployQA = reviewData.gate === "deploy_qa";
  // U9: Disable both buttons, show processing
  setButtonLoading(btnA, true, "Approving...");
  btnR.disabled = true;
  try {
    // U1: Persist comments before approve
    await persistComments();
    await authPost("/api/approve", { ticket, gate });
    document.getElementById("reviewStatus").textContent = isDeployQA ? "Approved — merging MR..." : "Approved!";
    document.getElementById("reviewStatus").style.color = "var(--green)";
    showToast(isDeployQA ? "Approved — merging MR..." : "Approved!", "success");
    // Broadcast to other tabs to prevent double-approve
    if (typeof crossTab !== "undefined") crossTab.send("gate:approved", { gate: gate, ticket: ticket });
    // Clear drafts after successful action
    formDrafts.clear("rejectText");
    // Announce to screen reader
    announceToScreenReader("Gate " + gate + " approved");
    // Leave buttons disabled after success
    btnA.classList.remove("btn-loading");
    btnA.textContent = isDeployQA ? "Approve & Merge" : "Approve";
  } catch (e) {
    showToast("Approval failed: " + e.message, "error");
    // U9: Re-enable on error
    setButtonLoading(btnA, false, isDeployQA ? "Approve & Merge" : "Approve");
    btnR.disabled = false;
  }
}

// U8: Show rejection preview modal
function rejectGate() {
  if (!reviewData || !reviewData.gate) return;
  var typedFeedback = document.getElementById("rejectText").value.trim();
  var inlineText = collectAllComments();
  var feedback = typedFeedback + inlineText;
  if (!feedback.trim()) return showToast("Please provide feedback for the rejection", "error");

  // Build preview content
  var previewHtml = "";

  // Show inline comments grouped by file
  var hasInline = false;
  for (var fp in reviewLineComments) {
    var fileComments = reviewLineComments[fp];
    var fileLines = [];
    for (var lk in fileComments) {
      fileComments[lk].forEach(function(c) {
        fileLines.push({ lineKey: lk, text: c.text });
      });
    }
    if (fileLines.length > 0) {
      hasInline = true;
      previewHtml += '<div class="preview-section"><h4>' + escHtml(fp) + '</h4>';
      fileLines.forEach(function(fl) {
        previewHtml += '<div class="preview-comment"><span class="comment-file">[' + escHtml(fl.lineKey) + ']</span> ' + escHtml(fl.text) + '</div>';
      });
      previewHtml += '</div>';
    }
  }

  if (typedFeedback) {
    previewHtml += '<div class="preview-section"><h4>Additional Feedback</h4>';
    previewHtml += '<div class="preview-feedback">' + escHtml(typedFeedback) + '</div></div>';
  }

  if (!hasInline && !typedFeedback) {
    previewHtml = '<div style="color:var(--text3);font-size:13px;padding:12px 0">No comments or feedback to send.</div>';
  }

  document.getElementById("rejectPreviewContent").innerHTML = previewHtml;
  document.getElementById("rejectPreviewModal").className = "reject-modal-overlay visible";
  // Focus trap in modal
  trapFocus(document.querySelector(".reject-modal"));
}

function closeRejectPreview() {
  document.getElementById("rejectPreviewModal").className = "reject-modal-overlay";
  releaseFocusTrap();
}

// U9: Double-submit prevention — actual rejection after preview confirmation
async function confirmReject() {
  closeRejectPreview();
  if (!reviewData || !reviewData.gate) return;
  const ticket = document.getElementById("ticket").value.trim() || "";
  const gate = GATE_STAGES[reviewData.gate] || reviewData.gate;
  var typedFeedback = document.getElementById("rejectText").value.trim();
  var inlineText = collectAllComments();
  var feedback = typedFeedback + inlineText;
  if (!feedback.trim()) return showToast("Please provide feedback for the rejection", "error");
  const btnA = document.getElementById("btnApprove");
  const btnR = document.getElementById("btnReject");
  // U9: Disable both buttons, show processing
  btnA.disabled = true;
  setButtonLoading(btnR, true, "Rejecting...");
  try {
    // U1: Persist comments before reject
    await persistComments();
    await authPost("/api/reject", { ticket, gate, feedback });
    document.getElementById("reviewStatus").textContent = "Rejected — agent will regenerate";
    document.getElementById("reviewStatus").style.color = "var(--red)";
    document.getElementById("rejectFeedback").className = "";
    document.getElementById("rejectText").value = "";
    reviewLineComments = {};
    openCommentForms = {};
    clearInlineCommentDrafts();
    showToast("Rejected — agent will regenerate", "info");
    // Broadcast to other tabs
    if (typeof crossTab !== "undefined") crossTab.send("gate:rejected", { gate: gate, ticket: ticket });
    // Clear drafts after successful rejection
    formDrafts.clear("rejectText");
    // Announce to screen reader
    announceToScreenReader("Gate " + gate + " rejected. Agent will regenerate code.");
    // Leave buttons disabled after success
    btnR.classList.remove("btn-loading");
    btnR.textContent = "Reject";
  } catch (e) {
    showToast("Rejection failed: " + e.message, "error");
    // U9: Re-enable on error
    setButtonLoading(btnR, false, "Reject");
    btnA.disabled = false;
  }
}

// U1: Persist inline comments to server
async function persistComments() {
  try {
    var ticket = document.getElementById("ticket").value.trim() || "";
    if (Object.keys(reviewLineComments).length > 0) {
      await authPost("/api/comments", { ticket: ticket, comments: reviewLineComments });
    }
  } catch {}
}

// U1: Load comments from server on page load
async function loadPersistedComments() {
  try {
    var ticket = document.getElementById("ticket").value.trim() || "";
    var res = await fetchWithTimeout("/api/comments?ticket=" + encodeURIComponent(ticket));
    var data = await res.json();
    if (data.comments && Object.keys(data.comments).length > 0) {
      reviewLineComments = data.comments;
    }
  } catch {}
}

// ── O9: Context injection ───────────────────────────────────────

async function injectContext() {
  var ticket = document.getElementById("ticket").value.trim() || "";
  var textarea = document.getElementById("contextInjectText");
  var context = textarea.value.trim();
  var statusEl = document.getElementById("injectStatus");
  var btn = document.getElementById("btnInjectContext");
  if (!context) { showToast("Please enter context text", "error"); return; }
  setButtonLoading(btn, true, "Injecting...");
  statusEl.textContent = "Injecting...";
  try {
    var res = await authPost("/api/inject-context", { ticket: ticket, context: context });
    var data = await res.json();
    if (data.ok) {
      statusEl.textContent = "Context injected at " + new Date().toLocaleTimeString();
      statusEl.style.color = "var(--green)";
      textarea.value = "";
      formDrafts.clear("contextText");
      showToast("Context injected successfully", "success");
    } else {
      statusEl.textContent = "Failed: " + (data.error || "Unknown error");
      statusEl.style.color = "var(--red)";
      showToast("Injection failed: " + (data.error || "Unknown error"), "error");
    }
  } catch (e) {
    statusEl.textContent = "Failed: " + e.message;
    statusEl.style.color = "var(--red)";
    showToast("Injection failed: " + e.message, "error");
  }
  setButtonLoading(btn, false, "Inject Context");
}

// ── O4: Log file viewer ────────────────────────────────────────

function toggleLogViewer() {
  logViewerOpen = !logViewerOpen;
  var content = document.getElementById("logViewerContent");
  var toggle = document.getElementById("logViewerToggle");
  var header = document.getElementById("logViewerHeader");
  if (logViewerOpen) {
    content.className = "log-viewer-content visible";
    toggle.className = "toggle-icon open";
    header.className = "log-viewer-header expanded";
    fetchLogFile();
    if (!logViewerInterval) logViewerInterval = setInterval(fetchLogFile, 15000);
  } else {
    content.className = "log-viewer-content";
    toggle.className = "toggle-icon";
    header.className = "log-viewer-header";
    if (logViewerInterval) { clearInterval(logViewerInterval); logViewerInterval = null; }
  }
}

async function fetchLogFile() {
  try {
    var ticket = document.getElementById("ticket").value.trim() || "";
    var res = await fetchWithTimeout("/api/logs-file?ticket=" + encodeURIComponent(ticket) + "&tail=50");
    var data = await res.json();
    var content = document.getElementById("logViewerContent");
    var totalEl = document.getElementById("logViewerTotal");
    totalEl.textContent = (data.total || 0) + " total lines";
    if (data.lines && data.lines.length > 0) {
      content.innerHTML = data.lines.map(function(line) {
        return '<div class="log-file-line">' + escHtml(line) + '</div>';
      }).join("");
      // Auto-scroll to bottom
      content.scrollTop = content.scrollHeight;
    } else {
      content.innerHTML = '<div class="log-file-line" style="color:var(--text3);font-style:italic">No log entries yet.</div>';
    }
    onFetchSuccess();
  } catch (e) { onFetchError(); }
}

// ── Poll state for step progress ─────────────────────────────────

// W1/W2: Completed gates tracking (from server)
var completedGates = null;
// O12: Last health check result
var lastHealth = null;

async function pollState() {
  try {
    const ticket = document.getElementById("ticket").value.trim() || "";
    const res = await fetchWithTimeout("/api/state?ticket=" + encodeURIComponent(ticket));
    const data = await res.json();
    if (data.state) {
      const prev = currentStage;
      currentStage = data.state.stage;
      // O5: Store state data for banners
      lastStateData = data.state.data || null;
      if (prev !== currentStage) {
        const idx = findActiveStepForStage(currentStage);
        if (idx >= 0) activeStep = idx;
        userSelectedStep = false;
        render();
        fetchReview();
        // Announce stage change to screen readers
        var stageLabel = currentStage ? currentStage.replace(/_/g, " ") : "unknown";
        announceToScreenReader("Pipeline stage changed to " + stageLabel);
      } else if (!userSelectedStep) {
        // Same stage — auto-advance within multi-step stages (e.g., generate_code)
        var bestIdx = findActiveStepForStage(currentStage);
        if (bestIdx >= 0 && bestIdx !== activeStep && STEPS[activeStep] && STEPS[activeStep].stage === currentStage) {
          activeStep = bestIdx;
        }
      }
    }
    isRunning = data.running;
    // O2: Track stuck detection from server
    isStuck = data.stuck || false;
    stuckMinutes = data.stuckMinutes || 0;
    // W1/W2: Track completed gates
    completedGates = data._completedGates || null;
    // O12: Track health status — show warning if unhealthy
    lastHealth = data.health || null;
    if (lastHealth && !lastHealth.alive && isRunning) {
      // Agent reference exists but process is dead — update UI
      isRunning = false;
    }
    lastPollTime = Date.now();
    render();
    onFetchSuccess();

    // Broadcast state to other tabs for sync
    if (typeof crossTab !== "undefined" && crossTab.isLeader) {
      crossTab.send("state:sync", {
        currentStage: currentStage,
        isRunning: isRunning,
        lastStateData: lastStateData,
      });
    }
  } catch { onFetchError(); }
}

// ================================================================
//  RESILIENCE LAYER — Cross-Tab Sync, Drafts, Router,
//  Accessibility, Skeletons, Offline Mode
// ================================================================

// ── 2. Cross-Tab Synchronization (BroadcastChannel + localStorage fallback) ──

var crossTab = (function() {
  var CHANNEL_NAME = "mi-dev-agent-sync";
  var bc = null;
  var _isLeader = true;
  var _tabId = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  var _listeners = {};

  // Try BroadcastChannel first
  try {
    bc = new BroadcastChannel(CHANNEL_NAME);
    bc.onmessage = function(e) {
      var msg = e.data;
      if (msg && msg.tabId !== _tabId && msg.type && _listeners[msg.type]) {
        _listeners[msg.type].forEach(function(fn) { fn(msg.payload); });
      }
    };
  } catch {
    // Fallback: localStorage events
    window.addEventListener("storage", function(e) {
      if (e.key !== CHANNEL_NAME || !e.newValue) return;
      try {
        var msg = JSON.parse(e.newValue);
        if (msg && msg.tabId !== _tabId && msg.type && _listeners[msg.type]) {
          _listeners[msg.type].forEach(function(fn) { fn(msg.payload); });
        }
      } catch {}
    });
  }

  function send(type, payload) {
    var msg = { tabId: _tabId, type: type, payload: payload, ts: Date.now() };
    if (bc) {
      try { bc.postMessage(msg); } catch {}
    } else {
      // localStorage fallback
      try { localStorage.setItem(CHANNEL_NAME, JSON.stringify(msg)); } catch {}
    }
  }

  function on(type, fn) {
    if (!_listeners[type]) _listeners[type] = [];
    _listeners[type].push(fn);
  }

  // ── Leader Election ──
  // Simple leader election: first tab to write its ID wins.
  // On visibilitychange, hidden tabs yield leadership.
  var LEADER_KEY = "mi-dev-agent-leader";
  var LEADER_HEARTBEAT_KEY = "mi-dev-agent-leader-hb";
  var leaderCheckInterval = null;

  function claimLeadership() {
    try {
      localStorage.setItem(LEADER_KEY, _tabId);
      localStorage.setItem(LEADER_HEARTBEAT_KEY, String(Date.now()));
    } catch {}
    _isLeader = true;
  }

  function checkLeadership() {
    try {
      var leader = localStorage.getItem(LEADER_KEY);
      var hb = parseInt(localStorage.getItem(LEADER_HEARTBEAT_KEY) || "0", 10);

      // If no leader, or leader heartbeat is stale (>10s), claim leadership
      if (!leader || (Date.now() - hb) > 10000) {
        claimLeadership();
        return;
      }

      if (leader === _tabId) {
        // We are leader — update heartbeat
        localStorage.setItem(LEADER_HEARTBEAT_KEY, String(Date.now()));
        _isLeader = true;
      } else {
        _isLeader = false;
      }
    } catch {
      _isLeader = true; // Fallback — act as leader if storage fails
    }
  }

  // Initial claim attempt
  checkLeadership();
  leaderCheckInterval = setInterval(checkLeadership, 5000);

  // Yield leadership when hidden, reclaim when visible
  document.addEventListener("visibilitychange", function() {
    if (document.hidden) {
      // If we are leader, announce we might yield
      if (_isLeader) {
        send("leader:yield", { tabId: _tabId });
      }
    } else {
      // When visible, check if leader spot is available
      checkLeadership();
      if (_isLeader) {
        // We became leader — start SSE if not already running
        if (!evtSource || evtSource.readyState === 2) {
          connectSSE();
        }
      }
    }
  });

  // Listen for leader yield
  on("leader:yield", function() {
    // Another tab yielded — try to claim if we're visible
    if (!document.hidden) {
      checkLeadership();
      if (_isLeader && (!evtSource || evtSource.readyState === 2)) {
        connectSSE();
      }
    }
  });

  // Listen for SSE data from leader tab
  on("sse:log", function(data) {
    if (!_isLeader) appendLog(data);
  });
  on("sse:status", function(data) {
    if (!_isLeader) {
      isRunning = data.running;
      render();
      showSyncedToast("status update");
    }
  });
  on("sse:review", function(data) {
    // Any tab receiving a review action broadcast should update
    if (data.action === "approved" || data.action === "rejected" || data.action === "refine") {
      fetchReview();
      showSyncedToast(data.action);
    }
  });

  // Broadcast gate actions to prevent double-approve
  on("gate:approved", function(data) {
    showSyncedToast("Gate " + (data.gate || "") + " approved");
    // Disable approve/reject buttons immediately to prevent double-submit
    var btnA = document.getElementById("btnApprove");
    var btnR = document.getElementById("btnReject");
    if (btnA) btnA.disabled = true;
    if (btnR) btnR.disabled = true;
    fetchReview();
    announceToScreenReader("Gate approved from another tab");
  });
  on("gate:rejected", function(data) {
    showSyncedToast("Gate " + (data.gate || "") + " rejected");
    fetchReview();
    announceToScreenReader("Gate rejected from another tab");
  });

  // Broadcast state sync for multi-tab consistency
  on("state:sync", function(data) {
    if (data && data.currentStage && data.currentStage !== currentStage) {
      currentStage = data.currentStage;
      lastStateData = data.lastStateData || null;
      isRunning = data.isRunning || false;
      var idx = findActiveStepForStage(currentStage);
      if (idx >= 0) activeStep = idx;
      render();
      showSyncedToast("state update");
    }
  });

  // Cleanup on unload
  window.addEventListener("beforeunload", function() {
    if (_isLeader) {
      try {
        localStorage.removeItem(LEADER_KEY);
        localStorage.removeItem(LEADER_HEARTBEAT_KEY);
      } catch {}
      send("leader:yield", { tabId: _tabId });
    }
  });

  // Debounced "Synced from another tab" toast to avoid spam
  var _lastSyncToast = 0;
  function showSyncedToast(detail) {
    var now = Date.now();
    if (now - _lastSyncToast < 3000) return; // Debounce: max once per 3s
    _lastSyncToast = now;
    var msg = "Synced from another tab";
    if (detail) msg += " (" + detail + ")";
    showToast(msg, "info", 3000);
  }

  return {
    send: send,
    on: on,
    showSyncedToast: showSyncedToast,
    get isLeader() { return _isLeader; },
    get tabId() { return _tabId; },
  };
})();


// ── 3. Form Draft Persistence ──

// Helper: get current ticket ID for scoping drafts per ticket
function _getDraftTicketId() {
  try {
    var el = document.getElementById("ticket");
    var v = el ? el.value.trim() : "";
    return v || "_global";
  } catch { return "_global"; }
}

var formDrafts = (function() {
  var STORAGE_KEY_BASE = "mi-dev-agent-drafts";
  var saveTimers = {};
  var hasDrafts = false;

  function storageKey() {
    return STORAGE_KEY_BASE + "_" + _getDraftTicketId();
  }

  function load() {
    try {
      var raw = localStorage.getItem(storageKey());
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }

  function save(drafts) {
    try { localStorage.setItem(storageKey(), JSON.stringify(drafts)); } catch {}
  }

  function get(key) {
    var drafts = load();
    return drafts[key] || "";
  }

  function set(key, value) {
    // Debounce saves — 500ms
    if (saveTimers[key]) clearTimeout(saveTimers[key]);
    saveTimers[key] = setTimeout(function() {
      var drafts = load();
      if (value && value.trim()) {
        drafts[key] = value;
        hasDrafts = true;
      } else {
        delete drafts[key];
      }
      save(drafts);
    }, 500);
  }

  function clear(key) {
    var drafts = load();
    delete drafts[key];
    save(drafts);
  }

  function clearAll() {
    try { localStorage.removeItem(storageKey()); } catch {}
    hasDrafts = false;
  }

  function restoreAll() {
    var drafts = load();
    var restoredAny = false;

    // Reject feedback textarea
    if (drafts.rejectText) {
      var rta = document.getElementById("rejectText");
      if (rta) { rta.value = drafts.rejectText; restoredAny = true; }
    }

    // Refine feedback textarea
    if (drafts.refineText) {
      var fta = document.getElementById("refineText");
      if (fta) { fta.value = drafts.refineText; restoredAny = true; }
    }

    // Context injection textarea
    if (drafts.contextText) {
      var cta = document.getElementById("contextInjectText");
      if (cta) { cta.value = drafts.contextText; restoredAny = true; }
    }

    // Ticket field
    if (drafts.ticketField) {
      var tf = document.getElementById("ticket");
      if (tf && !tf.value) { tf.value = drafts.ticketField; restoredAny = true; }
    }

    if (restoredAny) {
      hasDrafts = true;
      showToast("Draft restored from previous session", "info", 4000);
    }
    return restoredAny;
  }

  function hasUnsavedDrafts() {
    var drafts = load();
    return Object.keys(drafts).length > 0;
  }

  return {
    get: get,
    set: set,
    clear: clear,
    clearAll: clearAll,
    restoreAll: restoreAll,
    hasUnsavedDrafts: hasUnsavedDrafts,
  };
})();

// Wire up draft auto-save on textarea inputs
document.addEventListener("input", function(e) {
  var target = e.target;
  if (target.id === "rejectText") formDrafts.set("rejectText", target.value);
  else if (target.id === "refineText") formDrafts.set("refineText", target.value);
  else if (target.id === "contextInjectText") formDrafts.set("contextText", target.value);
  else if (target.id === "ticket") formDrafts.set("ticketField", target.value);
});

// Warn before unload if unsaved drafts
window.addEventListener("beforeunload", function(e) {
  if (formDrafts.hasUnsavedDrafts()) {
    e.preventDefault();
    e.returnValue = "You have unsaved draft text. Close anyway?";
  }
});


// ── 5. Accessibility — Focus Trap, ARIA, Keyboard ──

var _focusTrapEl = null;
var _focusTrapPrevious = null;

function trapFocus(el) {
  if (!el) return;
  _focusTrapEl = el;
  _focusTrapPrevious = document.activeElement;
  el.classList.add("focus-trap-active");

  // Focus the first focusable element
  var focusable = el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (focusable.length > 0) focusable[0].focus();
}

function releaseFocusTrap() {
  if (_focusTrapEl) _focusTrapEl.classList.remove("focus-trap-active");
  _focusTrapEl = null;
  if (_focusTrapPrevious) {
    try { _focusTrapPrevious.focus(); } catch {}
    _focusTrapPrevious = null;
  }
}

// Focus trap keydown handler
document.addEventListener("keydown", function(e) {
  if (!_focusTrapEl) return;

  if (e.key === "Escape") {
    e.preventDefault();
    // Close whatever modal is open
    dismissErrorOverlay();
    closeRejectPreview();
    hideShortcutsModal();
    releaseFocusTrap();
    return;
  }

  if (e.key !== "Tab") return;

  var focusable = _focusTrapEl.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (focusable.length === 0) return;

  var first = focusable[0];
  var last = focusable[focusable.length - 1];

  if (e.shiftKey) {
    if (document.activeElement === first) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});

/**
 * Announce state changes to screen readers via aria-live region.
 */
function announceToScreenReader(message) {
  var el = document.getElementById("ariaLiveRegion");
  if (!el) return;
  el.textContent = "";
  // Force DOM update for aria-live to re-announce
  setTimeout(function() { el.textContent = message; }, 50);
}


// ── 6. Client-Side Hash Router ──

var router = (function() {
  var _routes = {};
  var _currentRoute = null;
  var _notFoundHandler = null;

  function define(pattern, handler) {
    _routes[pattern] = handler;
  }

  function notFound(handler) {
    _notFoundHandler = handler;
  }

  function navigate(hash) {
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    } else {
      handleRoute();
    }
  }

  function handleRoute() {
    var hash = window.location.hash || "#/dashboard";
    var path = hash.replace(/^#/, "");

    // Try exact match first
    if (_routes[path]) {
      transitionRoute(function() { _routes[path]({}); });
      _currentRoute = path;
      return;
    }

    // Try parameterized routes
    for (var pattern in _routes) {
      var regex = pattern.replace(/:([^/]+)/g, "([^/]+)");
      var match = path.match(new RegExp("^" + regex + "$"));
      if (match) {
        var paramNames = (pattern.match(/:([^/]+)/g) || []).map(function(p) { return p.slice(1); });
        var params = {};
        paramNames.forEach(function(name, i) { params[name] = match[i + 1]; });
        transitionRoute(function() { _routes[pattern](params); });
        _currentRoute = path;
        return;
      }
    }

    // 404
    if (_notFoundHandler) {
      transitionRoute(function() { _notFoundHandler(path); });
    }
    _currentRoute = null;
  }

  function transitionRoute(renderFn) {
    var container = document.getElementById("mainContent");
    if (!container) { renderFn(); return; }
    container.classList.add("route-view", "fading");
    setTimeout(function() {
      renderFn();
      container.classList.remove("fading");
    }, 200);
  }

  // Listen for hash changes
  window.addEventListener("hashchange", handleRoute);

  return {
    define: define,
    notFound: notFound,
    navigate: navigate,
    handleRoute: handleRoute,
    get current() { return _currentRoute; },
  };
})();

// Route definitions — we keep #/dashboard as the main view
// Other routes just toggle visibility of existing sections

// The main dashboard is the default — show/hide sections based on route
var _mainSectionsVisible = true;

function showMainSections() {
  _mainSectionsVisible = true;
}

function hideMainSections() {
  _mainSectionsVisible = false;
}

function restoreMainSections() {
  _mainSectionsVisible = true;
  // Re-show pipeline grid (may have been hidden by settings/404)
  var grid = document.getElementById("stepsGrid");
  if (grid) grid.style.display = "";
}

router.define("/dashboard", function() {
  restoreMainSections();
  render();
});

router.define("/review/:ticket", function(params) {
  restoreMainSections();
  var ticketInput = document.getElementById("ticket");
  if (ticketInput && params.ticket) {
    ticketInput.value = params.ticket;
    pollState();
    fetchReview();
  }
  render();
  // Scroll to review panel
  var panel = document.getElementById("reviewPanel");
  if (panel) panel.scrollIntoView({ behavior: "smooth" });
});

router.define("/settings", function() {
  // Render settings page content
  renderSettingsPage();
});

router.notFound(function(path) {
  renderNotFoundPage(path);
});

function renderSettingsPage() {
  var card = document.getElementById("detailCard");
  if (!card) return;
  // Hide pipeline-specific sections, show settings
  var grid = document.getElementById("stepsGrid");
  if (grid) grid.style.display = "none";
  var reviewPanel = document.getElementById("reviewPanel");
  if (reviewPanel) reviewPanel.className = "";

  card.innerHTML = '<div class="settings-page">' +
    '<h2>Settings</h2>' +
    '<div class="settings-section">' +
      '<h3>Display</h3>' +
      '<div class="settings-row">' +
        '<span class="settings-label">Theme</span>' +
        '<div class="settings-toggle-switch' + ((document.documentElement.getAttribute("data-theme") === "light") ? " active" : "") + '" onclick="toggleTheme();renderSettingsPage()" role="switch" aria-checked="' + ((document.documentElement.getAttribute("data-theme") === "light") ? "true" : "false") + '" aria-label="Toggle light mode" tabindex="0"></div>' +
      '</div>' +
      '<div class="settings-row">' +
        '<span class="settings-label">Diff Mode</span>' +
        '<span class="settings-value">' + escHtml(diffMode) + '</span>' +
      '</div>' +
      '<div class="settings-row">' +
        '<span class="settings-label">Tab Role</span>' +
        '<span class="settings-value">' + (crossTab.isLeader ? "Leader (SSE active)" : "Follower (synced)") + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="settings-section">' +
      '<h3>Data</h3>' +
      '<div class="settings-row">' +
        '<span class="settings-label">Cached State</span>' +
        '<span class="settings-value">' + (lastCacheTime ? new Date(lastCacheTime).toLocaleTimeString() : "None") + '</span>' +
      '</div>' +
      '<div class="settings-row">' +
        '<span class="settings-label">Form Drafts</span>' +
        '<span class="settings-value">' + (formDrafts.hasUnsavedDrafts() ? "Has drafts" : "None") + '</span>' +
      '</div>' +
      '<div class="settings-row">' +
        '<span class="settings-label">Clear All Cached Data</span>' +
        '<button class="btn btn-reset" onclick="clearAllCachedData()" aria-label="Clear all cached data from localStorage" style="margin-left:auto">Clear Cache</button>' +
      '</div>' +
    '</div>' +
    '<div class="settings-section">' +
      '<h3>Connection</h3>' +
      '<div class="settings-row">' +
        '<span class="settings-label">Status</span>' +
        '<span class="settings-value" style="color:' + (isOnline ? 'var(--green)' : 'var(--red)') + '">' + (isOnline ? "Connected" : "Disconnected") + '</span>' +
      '</div>' +
      '<div class="settings-row">' +
        '<span class="settings-label">Last Poll</span>' +
        '<span class="settings-value">' + (lastPollTime ? new Date(lastPollTime).toLocaleTimeString() : "Never") + '</span>' +
      '</div>' +
    '</div>' +
    '<div style="margin-top:16px">' +
      '<a href="#/dashboard" class="btn btn-start" style="text-decoration:none;display:inline-block" aria-label="Return to dashboard">Back to Dashboard</a>' +
    '</div>' +
  '</div>';
}

function renderNotFoundPage(path) {
  var card = document.getElementById("detailCard");
  if (!card) return;
  var grid = document.getElementById("stepsGrid");
  if (grid) grid.style.display = "none";
  var reviewPanel = document.getElementById("reviewPanel");
  if (reviewPanel) reviewPanel.className = "";

  card.innerHTML = '<div class="not-found">' +
    '<h2>404</h2>' +
    '<p>Page not found: ' + escHtml(path || "") + '</p>' +
    '<a href="#/dashboard" class="btn btn-start" style="text-decoration:none;display:inline-block" aria-label="Return to dashboard">Go to Dashboard</a>' +
  '</div>';
}

function clearAllCachedData() {
  if (!confirm("Clear all cached data? This will remove drafts, cached state, and preferences.")) return;
  try {
    localStorage.removeItem("mi-dev-agent-cache");
    // Clear all ticket-scoped draft keys (pattern: mi-dev-agent-drafts_* and mi-dev-agent-comment-drafts_*)
    var keysToRemove = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && (k.indexOf("mi-dev-agent-drafts") === 0 || k.indexOf("mi-dev-agent-comment-drafts") === 0)) {
        keysToRemove.push(k);
      }
    }
    keysToRemove.forEach(function(k) { localStorage.removeItem(k); });
    localStorage.removeItem("mi-dev-agent-theme");
    localStorage.removeItem("diffMode");
    localStorage.removeItem("section-summary");
    localStorage.removeItem("section-logOutput");
    localStorage.removeItem("section-contextPanel");
  } catch {}
  showToast("All cached data cleared", "success", 3000);
  renderSettingsPage();
}


// ── 7. Loading & Skeleton States ──

var skeletonShown = true;

function showSkeletons() {
  skeletonShown = true;
  var grid = document.getElementById("stepsGrid");
  if (grid) {
    var pills = "";
    for (var i = 0; i < 12; i++) pills += '<div class="skeleton skeleton-pill" aria-hidden="true"></div>';
    grid.innerHTML = pills;
  }
  var card = document.getElementById("detailCard");
  if (card) card.innerHTML = '<div class="skeleton skeleton-card" aria-hidden="true"></div>';
  var log = document.getElementById("logTerminal");
  if (log) log.innerHTML = '<div class="skeleton skeleton-log" style="height:100%" aria-hidden="true"></div>';
  var summary = document.getElementById("summaryTable");
  if (summary) {
    var rows = "";
    for (var i = 0; i < 5; i++) rows += '<div class="skeleton skeleton-row" aria-hidden="true"></div>';
    summary.innerHTML = rows;
  }
  announceToScreenReader("Loading dashboard data...");
}

function hideSkeletons() {
  skeletonShown = false;
}

/**
 * Show loading spinner in review panel when data is being fetched.
 */
function showReviewLoading() {
  var panel = document.getElementById("reviewPanel");
  if (!panel) return;
  panel.className = "visible";
  panel.querySelector(".review-title").innerHTML = '<span>Review</span>';
  var diffEl = document.getElementById("diffViewer");
  if (diffEl) {
    diffEl.className = "visible";
    diffEl.innerHTML = '<div class="review-loading" role="status" aria-live="polite">' +
      '<div class="review-loading-spinner"></div>' +
      '<span>Loading review data...</span>' +
    '</div>';
  }
}

/**
 * Enhanced skeleton grid: render inline in stepsGrid.
 */
function renderSkeletonGrid() {
  var pills = "";
  for (var i = 0; i < 12; i++) {
    pills += '<div class="skeleton skeleton-pill" aria-hidden="true"></div>';
  }
  return pills;
}

// Diff render progress
var diffRenderProgress = { current: 0, total: 0 };

function showDiffProgress(current, total) {
  var el = document.getElementById("diffProgress");
  var textEl = document.getElementById("diffProgressText");
  var fillEl = document.getElementById("diffProgressFill");
  if (!el) return;
  el.classList.add("visible");
  el.setAttribute("aria-valuenow", String(current));
  diffRenderProgress.current = current;
  diffRenderProgress.total = total;
  if (textEl) textEl.textContent = "Rendering " + current + "/" + total + " files...";
  if (fillEl) fillEl.style.width = (total > 0 ? Math.round((current/total)*100) : 0) + "%";
}

function hideDiffProgress() {
  var el = document.getElementById("diffProgress");
  if (el) el.classList.remove("visible");
}

function showLargeFileWarning(lineCount) {
  var el = document.getElementById("diffLargeWarning");
  if (el) {
    if (lineCount >= 2000) {
      el.classList.add("visible");
    } else {
      el.classList.remove("visible");
    }
  }
}


// ── 8. Offline Mode — Cache & Queue ──

var offlineActionQueue = [];
var OFFLINE_QUEUE_MAX = 100;

function cacheCurrentState() {
  try {
    lastCacheTime = Date.now();
    var cacheData = {
      ts: lastCacheTime,
      isRunning: isRunning,
      currentStage: currentStage,
      lastStateData: lastStateData,
      reviewData: reviewData,
    };
    localStorage.setItem("mi-dev-agent-cache", JSON.stringify(cacheData));
  } catch {}
}

function loadCachedState() {
  try {
    var raw = localStorage.getItem("mi-dev-agent-cache");
    if (!raw) return false;
    var cache = JSON.parse(raw);
    if (!cache || !cache.ts) return false;

    lastCacheTime = cache.ts;
    isRunning = cache.isRunning || false;
    currentStage = cache.currentStage || null;
    lastStateData = cache.lastStateData || null;
    reviewData = cache.reviewData || null;

    if (currentStage) {
      var idx = findActiveStepForStage(currentStage);
      if (idx >= 0) activeStep = idx;
    }

    return true;
  } catch { return false; }
}

function queueOfflineAction(action) {
  offlineActionQueue.push({ action: action, ts: Date.now() });
  // Cap queue size — drop oldest items when exceeding max
  if (offlineActionQueue.length > OFFLINE_QUEUE_MAX) {
    var dropped = offlineActionQueue.length - OFFLINE_QUEUE_MAX;
    offlineActionQueue = offlineActionQueue.slice(dropped);
    showToast("Action queued (oldest " + dropped + " dropped, limit " + OFFLINE_QUEUE_MAX + ")", "info", 3000);
  } else {
    showToast("Action queued -- will execute when connected", "info", 3000);
  }
}

function replayOfflineQueue() {
  if (offlineActionQueue.length === 0) return;
  showToast("Replaying " + offlineActionQueue.length + " queued action(s)...", "info", 3000);
  var queue = offlineActionQueue.splice(0);
  queue.forEach(function(item) {
    try { item.action(); } catch {}
  });
}

function onConnectionRestored() {
  // Replay offline actions
  replayOfflineQueue();
  // Refresh data
  pollState();
  fetchReview();
}


// ── Theme Toggle ──

function toggleTheme() {
  var html = document.documentElement;
  var current = html.getAttribute("data-theme") || "dark";
  var next = current === "dark" ? "light" : "dark";
  html.setAttribute("data-theme", next);
  try { localStorage.setItem("mi-dev-agent-theme", next); } catch {}
  var btn = document.getElementById("themeToggle");
  if (btn) btn.innerHTML = next === "dark" ? "&#x263E;" : "&#x2600;";
}

function restoreTheme() {
  try {
    var stored = localStorage.getItem("mi-dev-agent-theme");
    if (stored) {
      document.documentElement.setAttribute("data-theme", stored);
      var btn = document.getElementById("themeToggle");
      if (btn) btn.innerHTML = stored === "dark" ? "&#x263E;" : "&#x2600;";
    }
  } catch {}
}


// ── Init ────────────────────────────────────────────────────────

var pollId = null;
var reviewId = null;

// V7: Pause/resume polling when tab is hidden, with leader election
document.addEventListener("visibilitychange", function() {
  if (document.hidden) {
    if (pollId) { clearInterval(pollId); pollId = null; }
    if (reviewId) { clearInterval(reviewId); reviewId = null; }
    // O4: Pause log viewer polling
    if (logViewerInterval) { clearInterval(logViewerInterval); logViewerInterval = null; }
  } else {
    if (!pollId) pollId = setInterval(pollState, 5000);
    if (!reviewId) reviewId = setInterval(fetchReview, 10000);
    // O4: Resume log viewer polling if open
    if (logViewerOpen && !logViewerInterval) {
      logViewerInterval = setInterval(fetchLogFile, 15000);
      fetchLogFile();
    }
    // Immediately fetch when becoming visible again
    pollState();
    fetchReview();
  }
});

(async function init() {
  // Theme
  restoreTheme();

  // Show skeletons while loading
  showSkeletons();

  // Restore collapsed sections
  restoreCollapsedSections();

  // Restore form drafts
  formDrafts.restoreAll();

  // Restore inline comment drafts
  if (restoreInlineCommentDrafts()) {
    var draftCount = Object.keys(openCommentForms).length;
    if (draftCount > 0) {
      showToast(draftCount + " inline comment draft(s) restored", "info", 4000);
    }
  }

  // Load cached state for instant render
  var hasCached = loadCachedState();
  if (hasCached) {
    hideSkeletons();
    render();
  }

  // Announce to screen reader
  announceToScreenReader("AI Dev Agent dashboard loaded");

  // Start SSE (only if leader tab)
  connectSSE();

  // Load persisted comments
  await loadPersistedComments();

  // Initial data fetch
  try {
    await pollState();
    await fetchReview();
  } catch {}

  hideSkeletons();
  render();

  // Handle initial route
  router.handleRoute();

  // Start polling intervals
  pollId = setInterval(pollState, 5000);
  reviewId = setInterval(fetchReview, 10000);

  // Enhancement 10: Heartbeat timer + stale age
  heartbeatTimer = setInterval(function() {
    updateHeartbeat();
    if (!isOnline) updateStaleAge();
  }, 5000);
})();
</script>
</body>`;
}

module.exports = { getHTML };
