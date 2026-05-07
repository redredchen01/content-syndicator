// Dashboard API Client
const API_BASE = '/api';

class MetricsClient {
  async getStats() {
    const res = await fetch(`${API_BASE}/stats`);
    return await res.json();
  }

  async getMetrics(operation, since) {
    const params = new URLSearchParams({ since, limit: 100 });
    if (operation) params.append('operation', operation);
    const res = await fetch(`${API_BASE}/metrics?${params}`);
    return await res.json();
  }

  async getTraces(name, since, limit = 50) {
    const params = new URLSearchParams({ since, limit });
    if (name) params.append('name', name);
    const res = await fetch(`${API_BASE}/traces?${params}`);
    return await res.json();
  }

  async analyze(operation, timeRange) {
    const res = await fetch(`${API_BASE}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation, timeRange })
    });
    return await res.json();
  }
}

const metricsClient = new MetricsClient();

/** Escape a value before inserting it into innerHTML. */
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// State
let charts = {};
let lastRefreshTime = null;
let autoRefreshTimer = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  initCharts();
  refreshData();
  startAutoRefresh();

  document.getElementById('timeRange').addEventListener('change', refreshData);
});

function initCharts() {
  // Latency chart
  const latencyChart = echarts.init(document.getElementById('latencyChart'));
  charts.latency = latencyChart;
  latencyChart.setOption({
    color: ['#1a73e8', '#34a853', '#fbbc04'],
    tooltip: { trigger: 'axis' },
    legend: { data: ['avg', 'p95', 'p99'] },
    xAxis: { type: 'time' },
    yAxis: { type: 'value', name: 'ms' },
    series: [
      { name: 'avg', type: 'line', smooth: true, data: [] },
      { name: 'p95', type: 'line', smooth: true, data: [] },
      { name: 'p99', type: 'line', smooth: true, data: [] }
    ]
  });

  // Error rate chart
  const errorRateChart = echarts.init(document.getElementById('errorRateChart'));
  charts.errorRate = errorRateChart;
  errorRateChart.setOption({
    color: ['#ea4335'],
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'time' },
    yAxis: { type: 'value', name: '%' },
    series: [
      { name: '错误率', type: 'bar', data: [] }
    ]
  });
}

async function refreshData() {
  try {
    const timeRange = document.getElementById('timeRange').value;

    // Fetch stats and metrics in parallel
    const [statsRes, metricsRes] = await Promise.all([
      metricsClient.getStats(),
      metricsClient.getMetrics('*', timeRange)
    ]);

    if (!statsRes.ok || !metricsRes.ok) {
      showError('Failed to fetch data: ' + (statsRes.error || metricsRes.error));
      return;
    }

    const stats = statsRes.data;
    const metricsData = metricsRes.data;

    // Update metric cards
    updateMetricCards(stats, metricsData);

    // Update charts
    updateCharts(metricsData);

    // Update anomalies
    await updateAnomalies(metricsData);

    lastRefreshTime = new Date().toLocaleTimeString();
    document.getElementById('refreshIndicator').textContent = `最后更新: ${lastRefreshTime}`;

  } catch (error) {
    console.error('Refresh error:', error);
    showError('刷新失败: ' + error.message);
  }
}

function updateMetricCards(stats, metricsData) {
  const results = metricsData.results || [];

  // Calculate aggregated metrics
  let totalOps = 0;
  let totalLatency = 0;
  let totalErrors = 0;
  let totalCount = 0;

  results.forEach(metric => {
    if (metric.operations) {
      Object.values(metric.operations).forEach(op => {
        totalOps += op.count || 0;
        totalLatency += (op.avgDuration || 0) * (op.count || 0);
        totalErrors += Math.round((op.errorRate || 0) * (op.count || 0));
        totalCount += op.count || 0;
      });
    }
  });

  const avgLatency = totalCount > 0 ? (totalLatency / totalCount).toFixed(1) : '-';
  const errorRate = totalCount > 0 ? ((totalErrors / totalCount) * 100).toFixed(2) : '-';

  document.getElementById('operationCount').textContent = totalOps.toLocaleString();
  document.getElementById('avgLatency').textContent = avgLatency;
  document.getElementById('errorRate').textContent = errorRate;

  // System health
  if (stats.systemMonitor) {
    const memPercent = stats.systemMonitor.memory?.percentage || 0;
    const indicator = document.querySelector('#systemHealth .status-indicator');
    const statusText = document.getElementById('healthStatus');

    if (memPercent > 80) {
      indicator.className = 'status-indicator status-error';
      statusText.textContent = '警告';
    } else if (memPercent > 60) {
      indicator.className = 'status-indicator status-warn';
      statusText.textContent = '有点忙';
    } else {
      indicator.className = 'status-indicator status-good';
      statusText.textContent = '正常';
    }
  }
}

function updateCharts(metricsData) {
  const results = metricsData.results || [];
  const timestamps = [];
  const avgDurations = [];
  const p95Durations = [];
  const p99Durations = [];
  const errorRates = [];

  // Aggregate by timestamp
  const byTimestamp = {};
  results.forEach(metric => {
    const ts = metric.timestamp || Date.now();
    if (!byTimestamp[ts]) {
      byTimestamp[ts] = { durations: [], errors: [], count: 0 };
    }

    if (metric.operations) {
      Object.values(metric.operations).forEach(op => {
        byTimestamp[ts].durations.push(...(op.samples || []));
        byTimestamp[ts].errors.push(op.errorRate || 0);
        byTimestamp[ts].count += op.count || 0;
      });
    }
  });

  // Process aggregated data
  Object.entries(byTimestamp).forEach(([ts, data]) => {
    timestamps.push(parseInt(ts));

    if (data.durations.length > 0) {
      const sorted = data.durations.sort((a, b) => a - b);
      const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
      const p95Idx = Math.floor(sorted.length * 0.95);
      const p99Idx = Math.floor(sorted.length * 0.99);

      avgDurations.push([ts, avg.toFixed(1)]);
      p95Durations.push([ts, sorted[p95Idx].toFixed(1)]);
      p99Durations.push([ts, sorted[p99Idx].toFixed(1)]);
    }

    if (data.errors.length > 0) {
      const avgError = (data.errors.reduce((a, b) => a + b, 0) / data.errors.length * 100).toFixed(2);
      errorRates.push([ts, avgError]);
    }
  });

  // Update latency chart
  charts.latency.setOption({
    series: [
      { data: avgDurations },
      { data: p95Durations },
      { data: p99Durations }
    ]
  });

  // Update error rate chart
  charts.errorRate.setOption({
    series: [
      { data: errorRates }
    ]
  });
}

async function updateAnomalies(metricsData) {
  const results = metricsData.results || [];
  const anomalies = [];

  results.forEach(metric => {
    if (metric.operations) {
      Object.entries(metric.operations).forEach(([opName, op]) => {
        if (op.isAnomaly) {
          const deviation = op.baseline ?
            (((op.avgDuration - op.baseline) / op.baseline) * 100).toFixed(1) :
            'N/A';

          anomalies.push({
            operation: opName,
            metric: 'latency',
            currentValue: op.avgDuration?.toFixed(1),
            baseline: op.baseline?.toFixed(1),
            deviation,
            timestamp: metric.timestamp
          });
        }

        if (op.errorRate && op.errorRate > 0.1) {
          anomalies.push({
            operation: opName,
            metric: 'error_rate',
            currentValue: (op.errorRate * 100).toFixed(2),
            deviation: '+' + (op.errorRate * 100).toFixed(2),
            timestamp: metric.timestamp
          });
        }
      });
    }
  });

  if (anomalies.length > 0) {
    document.getElementById('anomaliesPanel').style.display = 'block';
    const anomaliesList = document.getElementById('anomaliesList');
    anomaliesList.innerHTML = anomalies.slice(0, 5).map(a => `
      <div class="anomaly-item ${a.metric === 'error_rate' ? 'high' : ''}">
        <div class="anomaly-text">
          <div class="anomaly-op">${escHtml(a.operation)}</div>
          <div class="anomaly-detail">
            ${a.metric === 'latency'
              ? `延迟: ${escHtml(a.currentValue)}ms (基线: ${escHtml(a.baseline)}ms, ${escHtml(a.deviation)}%)`
              : `错误率: ${escHtml(a.currentValue)}%`}
          </div>
        </div>
        <button class="anomaly-btn" onclick="analyzeOperation('${escHtml(a.operation)}')">分析</button>
      </div>
    `).join('');
  } else {
    document.getElementById('anomaliesPanel').style.display = 'none';
  }
}

async function analyzeOperation(operation = null) {
  const op = operation || document.getElementById('analysisOperation').value;
  if (!op) {
    alert('请输入操作名称');
    return;
  }

  const resultDiv = document.getElementById('analysisResult');
  resultDiv.innerHTML = '<div class="loading"><span class="spinner"></span>分析中...</div>';

  try {
    const res = await metricsClient.analyze(op);

    if (!res.ok) {
      resultDiv.innerHTML = `<div class="error">分析失败: ${escHtml(res.error)}</div>`;
      return;
    }

    const analysis = res.data;
    resultDiv.innerHTML = `
      <div class="diagnosis-result">
        <div class="diagnosis-primary">诊断: ${escHtml(analysis.diagnosis.primary)}</div>

        ${analysis.diagnosis.factors.length > 0 ? `
          <div class="factors">
            <strong>问题因素:</strong>
            ${analysis.diagnosis.factors.map(f => `
              <div class="factor-item">
                <span class="factor-type">${escHtml(f.type)}</span>
                ${escHtml(f.metric)}: ${f.currentValue.toFixed(2)}
                (基线: ${f.baseline.toFixed(2)}, 严重度: ${escHtml(f.severity)})
              </div>
            `).join('')}
          </div>
        ` : ''}

        ${analysis.recommendations.length > 0 ? `
          <div class="recommendations">
            <strong>优化建议:</strong>
            ${analysis.recommendations.map(r => `
              <div class="rec-item">
                <strong>[P${escHtml(r.priority)}] ${escHtml(r.title)}</strong><br>
                ${escHtml(r.description)}<br>
                <small>预期改进: ${escHtml(r.estimatedImprovement)}</small>
              </div>
            `).join('')}
          </div>
        ` : ''}

        <div style="margin-top: 10px; font-size: 12px; color: #999;">
          置信度: ${(analysis.confidence * 100).toFixed(0)}%
          ${analysis.relatedTraces.length > 0 ? ` | 相关 trace: ${analysis.relatedTraces.length}` : ''}
        </div>
      </div>
    `;
  } catch (error) {
    resultDiv.innerHTML = `<div class="error">分析失败: ${escHtml(error.message)}</div>`;
  }
}

function startAutoRefresh() {
  autoRefreshTimer = setInterval(() => {
    refreshData();
  }, 2000); // Refresh every 2 seconds
}
// NOTE: refreshData() is declared as the async version at the top of this file.
// Do NOT re-declare it here — the async version handles updateMetricCards,
// updateCharts, updateAnomalies, and proper error display.

function showError(message) {
  console.error(message);
  // Could add a toast notification here
}
