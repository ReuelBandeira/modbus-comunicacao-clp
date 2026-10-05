import type { ModbusAction, ModbusMonitorOptions, ModbusMonitorResult, ModbusOptions, ModbusResult } from '../types/modbusTypes';
export interface ModbusApiContract {
    execute(action: 'monitor', options: ModbusMonitorOptions): Promise<ModbusMonitorResult>;
    execute(action: Exclude<ModbusAction, 'monitor'>, options: ModbusOptions): Promise<ModbusResult>;
}
