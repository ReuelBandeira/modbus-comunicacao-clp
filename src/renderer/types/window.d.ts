import type { TcpApiContract } from '../../modules/tcp/contracts/tcpApiContract';
import type { ModbusApiContract } from '../../modules/modbus/contracts/modbusApiContract';
import type { LineApiContract } from '../../modules/pcm/workflow/contracts/lineApiContract';
import type { StationApiContract } from '../../main/stationContract';

declare global {
    interface Window {
        tcp: TcpApiContract;
        modbus: ModbusApiContract;
        lineApi?: LineApiContract;
        station: StationApiContract;
    }
}
