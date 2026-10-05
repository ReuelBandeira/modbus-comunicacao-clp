import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

export type TemperatureStatus = 'normal' | 'warning' | 'critical' | 'unavailable';

export interface SystemTemperature {
    celsius: number | null;
    status: TemperatureStatus;
    warningAt: number;
    criticalAt: number;
    source: 'libre-hardware-monitor-http' | 'libre-hardware-monitor' | 'open-hardware-monitor' | 'windows-acpi' | 'linux-thermal' | null;
    capturedAt: Date;
}

const CACHE_MS = 15_000;
let cached: SystemTemperature | undefined;
let reading: Promise<SystemTemperature> | undefined;

function threshold(name: string, fallback: number, minimum: number, maximum: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
}

export function temperatureThresholds() {
    const warningAt = threshold('PC_TEMPERATURE_WARNING_C', 80, 30, 110);
    const configuredCritical = threshold('PC_TEMPERATURE_CRITICAL_C', 90, 31, 120);
    return { warningAt, criticalAt: configuredCritical > warningAt ? configuredCritical : Math.min(120, warningAt + 10) };
}

export function classifyTemperature(celsius: number | null, warningAt: number, criticalAt: number): TemperatureStatus {
    if (celsius === null || !Number.isFinite(celsius)) return 'unavailable';
    if (celsius >= criticalAt) return 'critical';
    if (celsius >= warningAt) return 'warning';
    return 'normal';
}

function validTemperatures(values: number[]): number[] {
    return values.filter(value => Number.isFinite(value) && value >= 0 && value <= 130);
}

function numericTemperature(value: unknown): number | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'string') return undefined;
    const match = value.replace(/\u00a0/g, ' ').match(/-?\d+(?:[.,]\d+)?/u);
    if (!match) return undefined;
    const parsed = Number(match[0].replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : undefined;
}

interface LibreHardwareTemperature {
    name: string;
    sensorId: string;
    value: number;
}

function readingsFromLibreHardwareMonitor(payload: unknown): LibreHardwareTemperature[] {
    const readings: LibreHardwareTemperature[] = [];
    const visit = (node: unknown) => {
        if (!node || typeof node !== 'object' || Array.isArray(node)) return;
        const item = node as Record<string, unknown>;
        const name = typeof item.Text === 'string' ? item.Text.trim().toLowerCase() : '';
        const isReferenceValue = name.includes('distance to tjmax')
            || name.includes('temperature sensor resolution')
            || name.includes('thermal sensor high limit')
            || name.includes('thermal sensor low limit')
            || name.includes('thermal sensor critical high limit')
            || name.includes('thermal sensor critical low limit')
            || name === 'critical temperature' || name === 'warning temperature';
        if (!isReferenceValue && typeof item.Type === 'string' && item.Type.toLowerCase() === 'temperature') {
            const value = numericTemperature(item.RawValue ?? item.Value);
            if (value !== undefined && validTemperatures([value]).length) readings.push({
                name,
                sensorId: typeof item.SensorId === 'string' ? item.SensorId.toLowerCase() : '',
                value
            });
        }
        if (Array.isArray(item.Children)) item.Children.forEach(visit);
    };
    visit(payload);
    return readings;
}

export function temperaturesFromLibreHardwareMonitor(payload: unknown): number[] {
    return readingsFromLibreHardwareMonitor(payload).map(reading => reading.value);
}

export function primaryTemperatureFromLibreHardwareMonitor(payload: unknown): number | undefined {
    const readings = readingsFromLibreHardwareMonitor(payload);
    const preferred = [
        readings.find(reading => reading.name === 'core max' && reading.sensorId.includes('/intelcpu/')),
        readings.find(reading => reading.name === 'core max'),
        readings.find(reading => reading.name === 'cpu package'),
        readings.find(reading => reading.name === 'core average')
    ].find((reading): reading is LibreHardwareTemperature => reading !== undefined);
    return preferred?.value ?? (readings.length ? Math.max(...readings.map(reading => reading.value)) : undefined);
}

async function libreHardwareMonitorHttpTemperatures(): Promise<number[]> {
    const endpoint = (process.env.LIBRE_HARDWARE_MONITOR_URL || 'http://127.0.0.1:8085/data.json').trim();
    if (!endpoint) return [];
    try {
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(2_500), redirect: 'error' });
        if (!response.ok) return [];
        const value = primaryTemperatureFromLibreHardwareMonitor(await response.json());
        return value === undefined ? [] : [value];
    } catch { return []; }
}

function windowsTemperatures(): Promise<{ values: number[]; source: SystemTemperature['source'] }> {
    const script = [
        "$values = @(Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor -ErrorAction SilentlyContinue | Where-Object SensorType -eq 'Temperature' | ForEach-Object { [double]$_.Value })",
        "$source = if ($values.Count) { 'libre-hardware-monitor' } else { '' }",
        "if (-not $values.Count) { $values = @(Get-CimInstance -Namespace root/OpenHardwareMonitor -ClassName Sensor -ErrorAction SilentlyContinue | Where-Object SensorType -eq 'Temperature' | ForEach-Object { [double]$_.Value }); if ($values.Count) { $source = 'open-hardware-monitor' } }",
        "if (-not $values.Count) { $values = @(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | ForEach-Object { [math]::Round(($_.CurrentTemperature / 10) - 273.15, 1) }); if ($values.Count) { $source = 'windows-acpi' } }",
        "Write-Output \"$source|$($values -join ',')\""
    ].join('; ');
    return new Promise(resolve => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
            { windowsHide: true, timeout: 3_000, maxBuffer: 32_768 }, (error, stdout) => {
                if (error) { resolve({ values: [], source: null }); return; }
                const [rawSource = '', rawValues = ''] = stdout.trim().split('|', 2);
                const sources = ['libre-hardware-monitor', 'open-hardware-monitor', 'windows-acpi'];
                resolve({ values: validTemperatures(rawValues.split(',').filter(Boolean).map(Number)),
                    source: sources.includes(rawSource) ? rawSource as SystemTemperature['source'] : null });
            });
    });
}

async function linuxTemperatures(): Promise<number[]> {
    try {
        const root = '/sys/class/thermal';
        const zones = (await readdir(root)).filter(name => name.startsWith('thermal_zone'));
        const values = await Promise.all(zones.map(async zone => Number((await readFile(`${root}/${zone}/temp`, 'utf8')).trim()) / 1000));
        return validTemperatures(values);
    } catch { return []; }
}

async function readTemperature(): Promise<SystemTemperature> {
    const { warningAt, criticalAt } = temperatureThresholds();
    const httpValues = process.platform === 'win32' ? await libreHardwareMonitorHttpTemperatures() : [];
    const windows = process.platform === 'win32' && !httpValues.length ? await windowsTemperatures() : undefined;
    const source: SystemTemperature['source'] = httpValues.length ? 'libre-hardware-monitor-http'
        : windows?.source || (process.platform === 'linux' ? 'linux-thermal' : null);
    const values = httpValues.length ? httpValues : windows?.values || (source === 'linux-thermal' ? await linuxTemperatures() : []);
    const celsius = values.length ? Math.round(Math.max(...values) * 10) / 10 : null;
    return { celsius, status: classifyTemperature(celsius, warningAt, criticalAt), warningAt, criticalAt, source, capturedAt: new Date() };
}

export function getSystemTemperature(): Promise<SystemTemperature> {
    if (cached && Date.now() - cached.capturedAt.getTime() < CACHE_MS) return Promise.resolve(cached);
    if (reading) return reading;
    reading = readTemperature().catch(() => {
        const { warningAt, criticalAt } = temperatureThresholds();
        return { celsius: null, status: 'unavailable' as const, warningAt, criticalAt, source: null, capturedAt: new Date() };
    }).then(result => { cached = result; return result; })
        .finally(() => { reading = undefined; });
    return reading;
}
