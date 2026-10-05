(() => {
    type Device = import('../../../modules/plcSignals/models/plcSignalModel').PlcDevice;
    type Signal = import('../../../modules/plcSignals/models/plcSignalModel').PlcSignal;
    type SignalState = import('../../../modules/plcSignals/models/plcSignalModel').PlcSignalState;
    type AlarmDefinition = import('../../../modules/plcSignals/models/plcSignalModel').PlcAlarmDefinition;
    type AggregateStatusMapping = NonNullable<Signal['aggregateStatusMappings']>[number];
    type MachineStatusMapping = NonNullable<Signal['machineStatus']>['mappings'][number];
    type Command = import('../../../modules/plcSignals/models/plcSignalModel').PlcCommand;
    type DowntimeReason = import('../../../modules/availability/models/availabilityModel').DowntimeReason;
    type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
    type View = { devices: Device[]; signals: Signal[]; commands: Command[]; alarms: AlarmDefinition[];
        machines: Array<{ machineId: string; name: string }> };
    type IhmMachine = { ihmMachineId: string; name: string };
    const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
    const value = (id: string) => get<HTMLInputElement | HTMLSelectElement>(id).value.trim();
    const check = (id: string) => get<HTMLInputElement>(id).checked;
    let token = '', view: View = { devices: [], signals: [], commands: [], alarms: [], machines: [] }, alarmMachines: IhmMachine[] = [];
    let editingDeviceId = '', editingSignalId = '', editingCommandId = '', editingAlarmId = '';
    let stateTimer: number | undefined;

    async function request<T>(method: Method, path: string, body?: unknown, auth = true): Promise<T> {
        const authorization = auth && token ? `Bearer ${token}` : undefined;
        let response: import('../../../modules/pcm/workflow/contracts/lineApiContract').LineApiResponse;
        if (window.lineApi) response = await window.lineApi.request(method, path, body, authorization);
        else {
            const result = await fetch(path, { method, headers: { 'Content-Type': 'application/json',
                ...(authorization ? { Authorization: authorization } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
            response = { ...await result.json(), httpStatus: result.status };
        }
        if (response.httpStatus === 401 && auth) logout();
        if (response.httpStatus >= 400 || response.status !== 'OK') throw new Error(response.msg || 'Operação não confirmada.');
        return response.data as T;
    }
    function notice(text: string, error = false) {
        const target = get('message'); target.textContent = text; target.className = error ? 'notice error' : 'notice'; target.hidden = !text;
    }
    function option(select: HTMLSelectElement, optionValue: string, label: string) {
        const item = document.createElement('option'); item.value = optionValue; item.textContent = label; select.append(item);
    }
    function cell(row: HTMLTableRowElement, text = '') { const td = document.createElement('td'); td.textContent = text; row.append(td); return td; }
    function action(text: string, className: string, callback: () => void) {
        const button = document.createElement('button'); button.type = 'button'; button.className = `button ${className}`;
        button.textContent = text; button.onclick = callback; return button;
    }
    function beginSubmit(form: HTMLFormElement) {
        const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
        if (submit.disabled) return undefined;
        submit.disabled = true; return submit;
    }
    function deviceName(plcId?: string, machineId?: string) {
        if (plcId) return view.devices.find(item => item.plcId === plcId)?.name || 'CLP removida';
        return machineId ? `Estação legada: ${machineId.toUpperCase()}` : 'Sem vínculo';
    }
    function selectedReplicaPlcs() {
        return [...document.querySelectorAll<HTMLInputElement>('[data-command-replica]:checked')].map(item => item.value);
    }
    function renderReplicaDevices(selected = selectedReplicaPlcs()) {
        const container = get('command-replica-devices'), primary = value('command-device'); container.replaceChildren();
        for (const device of view.devices.filter(item => item.enabled && item.plcId !== primary)) {
            const label = document.createElement('label'); label.className = 'check-field';
            const input = document.createElement('input'); input.type = 'checkbox'; input.value = device.plcId;
            input.dataset.commandReplica = 'true'; input.checked = selected.includes(device.plcId);
            label.append(input, document.createTextNode(` ${device.name} · ${device.host}:${device.port}`)); container.append(label);
        }
        if (!container.children.length) container.textContent = primary ? 'Nenhuma outra CLP ativa cadastrada.' : 'Selecione a CLP principal.';
    }
    function fillDeviceSelects() {
        const signal = get<HTMLSelectElement>('signal-device'), command = get<HTMLSelectElement>('command-device');
        const machine = get<HTMLSelectElement>('command-machine');
        const selectedSignal = signal.value, selectedCommand = command.value;
        const selectedMachine = machine.value;
        signal.replaceChildren(); command.replaceChildren(); machine.replaceChildren();
        option(signal, '', 'Selecione uma CLP'); option(command, '', 'Selecione uma CLP');
        for (const device of view.devices.filter(item => item.enabled)) {
            const label = `${device.name} · ${device.host}:${device.port}`;
            option(signal, device.plcId, label); option(command, device.plcId, label);
        }
        if (view.devices.some(item => item.plcId === selectedSignal && item.enabled)) signal.value = selectedSignal;
        if (view.devices.some(item => item.plcId === selectedCommand && item.enabled)) command.value = selectedCommand;
        option(machine, '', 'Selecione uma máquina');
        for (const item of view.machines) option(machine, item.machineId, `${item.name} · ${item.machineId}`);
        if (view.machines.some(item => item.machineId === selectedMachine)) machine.value = selectedMachine;
        fillAckSignals(); renderReplicaDevices(); fillAlarmSelects(); fillMachineStatusSelect();
    }
    function fillMachineStatusSelect(selected = value('signal-status-machine')) {
        const machine = get<HTMLSelectElement>('signal-status-machine'); machine.replaceChildren();
        option(machine, '', 'Selecione uma máquina IHM');
        for (const item of alarmMachines) option(machine, item.ihmMachineId, item.name);
        if (alarmMachines.some(item => item.ihmMachineId === selected)) machine.value = selected;
    }
    function fillAlarmSelects(selectedSignal = value('alarm-signal'), selectedMachine = value('alarm-machine')) {
        const signal = get<HTMLSelectElement>('alarm-signal'), machine = get<HTMLSelectElement>('alarm-machine');
        signal.replaceChildren(); machine.replaceChildren(); option(signal, '', 'Selecione um sinal');
        option(machine, '', 'Alarme geral da linha');
        for (const item of view.signals.filter(entry => entry.enabled || entry.signalId === selectedSignal)) option(signal, item.signalId,
            `${item.label} · ${deviceName(item.plcId, item.machineId)} · ${item.plcAddress}${item.enabled ? '' : ' · INATIVO'}`);
        for (const item of alarmMachines) option(machine, item.ihmMachineId, item.name);
        if (view.signals.some(item => item.signalId === selectedSignal)) signal.value = selectedSignal;
        if (alarmMachines.some(item => item.ihmMachineId === selectedMachine)) machine.value = selectedMachine;
        updateAlarmFields();
    }
    function fillAckSignals(selected = value('command-ack')) {
        const select = get<HTMLSelectElement>('command-ack'), plcId = value('command-device');
        select.replaceChildren(); option(select, '', plcId ? 'Sem confirmação · somente escrita' : 'Selecione primeiro a CLP');
        for (const signal of view.signals.filter(item => item.plcId === plcId && (item.enabled || item.signalId === selected))) {
            option(select, signal.signalId, `${signal.label}${signal.enabled ? '' : ' · INATIVO'}`);
        }
        if (view.signals.some(item => item.signalId === selected && item.plcId === plcId)) select.value = selected;
    }
    function renderCommandInterlocks(command?: Command) {
        const container = get('command-interlocks'); container.replaceChildren();
        const configuredIds = new Set(command?.interlocks?.map(item => item.signalId) ?? []);
        for (const signal of view.signals.filter(item => item.enabled || configuredIds.has(item.signalId))) {
            const configured = command?.interlocks?.find(item => item.signalId === signal.signalId);
            const row = document.createElement('label'); row.className = 'interlock-row'; row.dataset.signalId = signal.signalId;
            const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = !!configured;
            const name = document.createElement('strong'); name.textContent = `${signal.label}${signal.enabled ? '' : ' · INATIVO'}`;
            const expected = document.createElement('select');
            expected.dataset.interlockMode = 'true';
            option(expected, 'inactive', 'Liberar se inativo'); option(expected, 'active', 'Liberar se ativo');
            option(expected, 'blocked_values', 'Bloquear por valor');
            expected.value = configured?.blockedValues?.length ? 'blocked_values' : configured?.requiredActive ? 'active' : 'inactive';
            const blockedValues = document.createElement('input'); blockedValues.type = 'text';
            blockedValues.dataset.interlockValues = 'true'; blockedValues.placeholder = 'Valores: 0, 2, 3';
            blockedValues.value = configured?.blockedValues?.join(', ') || '';
            const message = document.createElement('input'); message.type = 'text'; message.maxLength = 200;
            message.dataset.interlockMessage = 'true';
            message.placeholder = 'Mensagem quando bloqueado'; message.value = configured?.message || `${signal.label} impede o comando.`;
            const updateMode = () => {
                expected.disabled = !enabled.checked; message.disabled = !enabled.checked;
                blockedValues.disabled = !enabled.checked || expected.value !== 'blocked_values';
            };
            enabled.onchange = updateMode; expected.onchange = updateMode; updateMode();
            row.append(enabled, name, expected, blockedValues, message); container.append(row);
        }
        if (!container.children.length) container.textContent = 'Cadastre sinais monitorados para configurar intertravamentos.';
    }
    function commandInterlocks(): NonNullable<Command['interlocks']> {
        const interlocks: NonNullable<Command['interlocks']> = [];
        for (const row of document.querySelectorAll<HTMLElement>('.interlock-row')) {
            const enabled = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
            if (!enabled.checked) continue;
            const mode = row.querySelector<HTMLSelectElement>('[data-interlock-mode]')!.value;
            const message = row.querySelector<HTMLInputElement>('[data-interlock-message]')!.value.trim();
            if (mode === 'blocked_values') {
                const raw = row.querySelector<HTMLInputElement>('[data-interlock-values]')!.value.trim();
                const blockedValues = raw.split(/[,;\s]+/).filter(Boolean).map(item => Number(item));
                if (!blockedValues.length || blockedValues.some(item => !Number.isInteger(item) || item < 0 || item > 65535)) {
                    throw new Error('Informe valores inteiros entre 0 e 65535 no intertravamento.');
                }
                const signal = view.signals.find(item => item.signalId === row.dataset.signalId);
                if (signal && (['coil', 'discrete_input'].includes(signal.readType) || signal.bit !== undefined)
                    && blockedValues.some(item => item !== 0 && item !== 1)) {
                    throw new Error(`O intertravamento de ${signal.label} aceita somente os valores 0 e 1.`);
                }
                interlocks.push({ signalId: row.dataset.signalId!, blockedValues, message });
            } else {
                interlocks.push({ signalId: row.dataset.signalId!, requiredActive: mode === 'active', message });
            }
        }
        return interlocks;
    }
    function renderStatusMappings(containerId: string, mappings: Array<MachineStatusMapping | AggregateStatusMapping> = [],
        defaults: Array<MachineStatusMapping | AggregateStatusMapping>, withBlocking = false) {
        const container = get(containerId); container.replaceChildren();
        const values = mappings.length ? mappings : defaults;
        for (const mapping of values) {
            const row = document.createElement('div'); row.className = 'line-status-mapping';
            const valueLabel = document.createElement('label'); valueLabel.textContent = 'Valor da CLP';
            const valueInput = document.createElement('input'); valueInput.type = 'number'; valueInput.min = '0'; valueInput.max = '65535';
            valueInput.required = true; valueInput.value = String(mapping.value); valueInput.dataset.statusValue = 'true'; valueLabel.append(valueInput);
            const nameLabel = document.createElement('label'); nameLabel.textContent = 'Nome do estado';
            const nameInput = document.createElement('input'); nameInput.maxLength = 40; nameInput.required = true;
            nameInput.value = mapping.label; nameInput.dataset.statusLabel = 'true'; nameLabel.append(nameInput);
            const colorLabel = document.createElement('label'); colorLabel.textContent = 'Cor';
            const color = document.createElement('select'); color.dataset.statusColor = 'true';
            for (const [key, label] of [['gray', 'Cinza'], ['green', 'Verde'], ['yellow', 'Amarelo'], ['red', 'Vermelho'], ['blue', 'Azul']]) option(color, key, label);
            color.value = mapping.color; colorLabel.append(color);
            row.append(valueLabel, nameLabel, colorLabel);
            if (withBlocking) {
                const productionLabel = document.createElement('label'); productionLabel.textContent = 'Estado produtivo';
                const production = document.createElement('select'); production.dataset.statusProductionState = 'true';
                for (const [key, label] of [['', 'Não participa'], ['stopped', 'Parada'], ['running', 'Produzindo'],
                    ['warning', 'Alerta/transição'], ['emergency', 'Emergência']]) option(production, key, label);
                production.value = 'productionState' in mapping ? mapping.productionState || '' : '';
                productionLabel.append(production); row.append(productionLabel);
                const blockingLabel = document.createElement('label'); blockingLabel.className = 'check-field';
                const blocking = document.createElement('input'); blocking.type = 'checkbox'; blocking.dataset.statusBlocksEntry = 'true';
                blocking.checked = 'blocksEntry' in mapping ? mapping.blocksEntry : true;
                blockingLabel.append(blocking, ' Bloquear novas entradas'); row.append(blockingLabel);
            }
            row.append(action('Remover', 'danger', () => row.remove())); container.append(row);
        }
    }
    function renderAggregateStatusMappings(mappings: Signal['aggregateStatusMappings'] = []) {
        renderStatusMappings('aggregate-status-mappings', mappings, [
            { value: 0, label: 'Linha parada', color: 'gray', blocksEntry: false, productionState: 'stopped' },
            { value: 1, label: 'Linha em produção', color: 'green', blocksEntry: false, productionState: 'running' },
            { value: 2, label: 'Alerta da linha', color: 'yellow', blocksEntry: false, productionState: 'warning' },
            { value: 3, label: 'Linha em emergência', color: 'red', blocksEntry: true, productionState: 'emergency' }
        ], true);
    }
    function renderMachineStatusMappings(mappings: MachineStatusMapping[] = []) {
        renderStatusMappings('machine-status-mappings', mappings, [
            { value: 0, label: 'Máquina parada', color: 'gray' },
            { value: 1, label: 'Em produção', color: 'green' },
            { value: 2, label: 'Em alerta', color: 'yellow' },
            { value: 3, label: 'Em emergência', color: 'red' }
        ]);
    }
    function statusMappings(checkboxId: string, containerId: string): MachineStatusMapping[] {
        if (!check(checkboxId)) return [];
        const rows = [...get(containerId).querySelectorAll<HTMLElement>('.line-status-mapping')];
        if (!rows.length) throw new Error('Adicione pelo menos um estado ao mapeamento selecionado.');
        const mappings = rows.map(row => ({
            value: Number(row.querySelector<HTMLInputElement>('[data-status-value]')!.value),
            label: row.querySelector<HTMLInputElement>('[data-status-label]')!.value.trim(),
            color: row.querySelector<HTMLSelectElement>('[data-status-color]')!.value as MachineStatusMapping['color']
        }));
        if (new Set(mappings.map(item => item.value)).size !== mappings.length) {
            throw new Error('Cada estado do mapeamento deve ter um valor diferente.');
        }
        return mappings;
    }
    const aggregateStatusMappings = (): AggregateStatusMapping[] => {
        if (!check('signal-aggregate-status')) return [];
        const rows = [...get('aggregate-status-mappings').querySelectorAll<HTMLElement>('.line-status-mapping')];
        if (!rows.length) throw new Error('Adicione pelo menos um estado ao status agregado.');
        const mappings = rows.map(row => ({
            value: Number(row.querySelector<HTMLInputElement>('[data-status-value]')!.value),
            label: row.querySelector<HTMLInputElement>('[data-status-label]')!.value.trim(),
            color: row.querySelector<HTMLSelectElement>('[data-status-color]')!.value as AggregateStatusMapping['color'],
            blocksEntry: row.querySelector<HTMLInputElement>('[data-status-blocks-entry]')!.checked,
            ...(row.querySelector<HTMLSelectElement>('[data-status-production-state]')!.value
                ? { productionState: row.querySelector<HTMLSelectElement>('[data-status-production-state]')!.value as AggregateStatusMapping['productionState'] }
                : {})
        }));
        if (new Set(mappings.map(item => item.value)).size !== mappings.length) {
            throw new Error('Cada estado agregado deve ter um valor diferente.');
        }
        return mappings;
    };
    const machineStatusMappings = () => statusMappings('signal-machine-status', 'machine-status-mappings');
    function updateAggregateStatusFields() {
        const enabled = check('signal-aggregate-status'); get('aggregate-status-config').hidden = !enabled;
        document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#aggregate-status-mappings input, #aggregate-status-mappings select')
            .forEach(control => control.disabled = !enabled);
    }
    function updateMachineStatusFields() {
        const enabled = check('signal-machine-status'); get('machine-status-config').hidden = !enabled;
        document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#machine-status-config input, #machine-status-config select')
            .forEach(control => control.disabled = !enabled);
        get<HTMLSelectElement>('signal-status-machine').required = enabled;
    }
    function updateSignalFields() {
        const booleanRead = ['coil', 'discrete_input'].includes(value('signal-read-type'));
        const bit = get<HTMLInputElement>('signal-bit');
        if (booleanRead) bit.value = '';
        bit.disabled = booleanRead;
        get('signal-bit-field').classList.toggle('field-disabled', booleanRead);
        const exactRegisterValue = !booleanRead && !bit.value;
        const trigger = get<HTMLInputElement>('signal-trigger-value');
        trigger.disabled = !exactRegisterValue; trigger.required = exactRegisterValue;
        get('signal-trigger-field').classList.toggle('field-disabled', !exactRegisterValue);
        get<HTMLInputElement>('signal-active-value').disabled = exactRegisterValue;
        get('signal-active-value-field').classList.toggle('field-disabled', exactRegisterValue);
        const booleanValue = booleanRead || !!bit.value;
        document.querySelectorAll<HTMLInputElement>('[data-status-value]').forEach(input => {
            input.max = booleanValue ? '1' : '65535';
            input.title = booleanValue ? 'Este sinal aceita somente os estados 0 e 1.' : '';
        });
    }
    function resetDeviceForm() {
        editingDeviceId = ''; get<HTMLFormElement>('device-form').reset();
        get<HTMLInputElement>('device-enabled').checked = true; get<HTMLInputElement>('device-port').value = '502';
        get<HTMLInputElement>('device-unit').value = '1'; get<HTMLInputElement>('device-timeout').value = '3000';
        get<HTMLFormElement>('device-form').querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent = 'Cadastrar CLP';
        get<HTMLButtonElement>('device-cancel').hidden = true;
    }
    function renderDevices() {
        const output = get('device-list'); output.replaceChildren();
        for (const device of view.devices) {
            const card = document.createElement('article'); card.className = `device-card${device.enabled ? '' : ' inactive'}`;
            const name = document.createElement('strong'); name.textContent = device.name;
            const endpoint = document.createElement('span'); endpoint.className = 'device-endpoint'; endpoint.textContent = `${device.host}:${device.port}`;
            const meta = document.createElement('span'); meta.className = 'device-meta'; meta.textContent = `Unit ID ${device.unitId} · timeout ${device.timeoutMs} ms · ${device.enabled ? 'ativa' : 'inativa'}`;
            const actions = document.createElement('div'); actions.className = 'device-actions';
            actions.append(action('Editar', 'secondary', () => editDevice(device)), action('Remover', 'danger', () => void removeDevice(device)));
            card.append(name, endpoint, meta, actions); output.append(card);
        }
        if (!view.devices.length) { const empty = document.createElement('p'); empty.className = 'table-empty'; empty.textContent = 'Nenhuma CLP cadastrada.'; output.append(empty); }
    }
    function editDevice(device: Device) {
        editingDeviceId = device.plcId; get<HTMLInputElement>('device-name').value = device.name;
        get<HTMLInputElement>('device-host').value = device.host; get<HTMLInputElement>('device-port').value = String(device.port);
        get<HTMLInputElement>('device-unit').value = String(device.unitId); get<HTMLInputElement>('device-timeout').value = String(device.timeoutMs);
        get<HTMLInputElement>('device-enabled').checked = device.enabled;
        get<HTMLButtonElement>('device-form').querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent = 'Salvar CLP';
        get<HTMLButtonElement>('device-cancel').hidden = false;
        get('device-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    async function removeDevice(device: Device) {
        if (!confirm(`Remover a CLP ${device.name}?`)) return;
        try { await request('DELETE', `/api/plc-devices/${device.plcId}`);
            if (editingDeviceId === device.plcId) resetDeviceForm(); await refresh(); notice('CLP removida.'); }
        catch (error) { notice(error instanceof Error ? error.message : 'Remoção não confirmada.', true); }
    }
    function renderSignals() {
        const output = get<HTMLTableSectionElement>('signal-list'); output.replaceChildren();
        const behaviorLabels: Record<Signal['behavior'], string> = {
            warn: 'Somente informar', pause_entry: 'Pausar entradas', block_line: 'Bloquear linha',
            record_stop: 'Registrar parada no OEE'
        };
        for (const signal of view.signals) {
            const row = document.createElement('tr');
            cell(row, signal.label); const target = cell(row, deviceName(signal.plcId, signal.machineId));
            if (!signal.plcId) target.className = 'legacy-link';
            cell(row, `${signal.plcAddress} · ${signal.readType} @ ${signal.address}${signal.bit === undefined ? '' : ` bit ${signal.bit}`}${signal.triggerValue === undefined ? '' : ` · ativa=${signal.triggerValue}`}`);
            const live = cell(row); live.dataset.signalState = signal.signalId; live.textContent = 'Aguardando leitura';
            const reason = signal.behavior === 'record_stop' ? ' · OEE' : '';
            const rules = [signal.onActivateAction && signal.onActivateAction !== 'none' ? `↑ ${signal.onActivateAction}` : '',
                signal.onDeactivateAction && signal.onDeactivateAction !== 'none' ? `↓ ${signal.onDeactivateAction}` : ''].filter(Boolean).join(' · ');
            cell(row, `${behaviorLabels[signal.behavior]}${reason}${rules ? ` · ${rules}` : ''} · ${signal.enabled ? 'ativo' : 'inativo'}`);
            if (signal.aggregateStatusMappings?.length) {
                const marker = document.createElement('span'); marker.className = 'line-status-marker'; marker.textContent = 'STATUS AGREGADO';
                row.cells[4]?.append(document.createElement('br'), marker);
            }
            if (signal.machineStatus) {
                const marker = document.createElement('span'); marker.className = 'line-status-marker'; marker.textContent = 'STATUS DA MÁQUINA';
                row.cells[4]?.append(document.createElement('br'), marker);
            }
            const actions = cell(row); actions.className = 'signal-actions';
            actions.append(action('Editar', 'secondary', () => editSignal(signal)),
                action('Remover', 'danger', () => void removeSignal(signal))); output.append(row);
        }
        if (!output.children.length) { const row = document.createElement('tr'); const empty = cell(row, 'Nenhum sinal cadastrado.'); empty.className = 'table-empty'; empty.colSpan = 6; }
    }
    async function removeSignal(signal: Signal) {
        if (!confirm(`Remover o sinal ${signal.label}?`)) return;
        try { await request('DELETE', `/api/plc-signals/${signal.signalId}`);
            if (editingSignalId === signal.signalId) resetSignalForm(); await refresh(); notice('Sinal removido.'); }
        catch (error) { notice(error instanceof Error ? error.message : 'Remoção não confirmada.', true); }
    }
    function editSignal(signal: Signal) {
        editingSignalId = signal.signalId;
        get<HTMLSelectElement>('signal-device').value = signal.plcId || '';
        get<HTMLInputElement>('signal-label').value = signal.label; get<HTMLInputElement>('signal-plc-address').value = signal.plcAddress;
        get<HTMLSelectElement>('signal-read-type').value = signal.readType; get<HTMLInputElement>('signal-address').value = String(signal.address);
        get<HTMLInputElement>('signal-bit').value = signal.bit === undefined ? '' : String(signal.bit);
        get<HTMLInputElement>('signal-trigger-value').value = String(signal.triggerValue ?? 1);
        get<HTMLInputElement>('signal-polling').value = String(signal.pollingMs); get<HTMLSelectElement>('signal-severity').value = signal.severity;
        get<HTMLSelectElement>('signal-behavior').value = signal.behavior;
        get<HTMLSelectElement>('signal-on-activate').value = signal.onActivateAction || 'none';
        get<HTMLSelectElement>('signal-on-deactivate').value = signal.onDeactivateAction || 'none';
        get<HTMLSelectElement>('signal-downtime-reason').value = signal.downtimeReasonId || '';
        get<HTMLInputElement>('signal-active-value').checked = signal.activeValue;
        get<HTMLInputElement>('signal-enabled').checked = signal.enabled;
        get<HTMLInputElement>('signal-aggregate-status').checked = !!signal.aggregateStatusMappings?.length;
        renderAggregateStatusMappings(signal.aggregateStatusMappings);
        get<HTMLInputElement>('signal-machine-status').checked = !!signal.machineStatus;
        fillMachineStatusSelect(signal.machineStatus?.ihmMachineId || '');
        renderMachineStatusMappings(signal.machineStatus?.mappings);
        get<HTMLFormElement>('signal-form').querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent = 'Salvar sinal';
        get<HTMLButtonElement>('signal-cancel').hidden = false;
        updateBehavior(); updateSignalFields(); updateAggregateStatusFields(); updateMachineStatusFields();
        get('signal-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    function resetSignalForm() {
        editingSignalId = ''; get<HTMLFormElement>('signal-form').reset();
        get<HTMLInputElement>('signal-active-value').checked = true; get<HTMLInputElement>('signal-enabled').checked = true;
        get<HTMLInputElement>('signal-polling').value = '200'; get<HTMLInputElement>('signal-trigger-value').value = '1';
        get<HTMLSelectElement>('signal-on-activate').value = 'none'; get<HTMLSelectElement>('signal-on-deactivate').value = 'none';
        get<HTMLInputElement>('signal-aggregate-status').checked = false; renderAggregateStatusMappings();
        get<HTMLInputElement>('signal-machine-status').checked = false; renderMachineStatusMappings(); fillMachineStatusSelect('');
        get<HTMLFormElement>('signal-form').querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent = 'Cadastrar sinal';
        get<HTMLButtonElement>('signal-cancel').hidden = true;
        updateBehavior(); updateSignalFields(); updateAggregateStatusFields(); updateMachineStatusFields();
    }
    const alarmSeverityLabels: Record<AlarmDefinition['severity'], string> = {
        info: 'Informação', warning: 'Alerta', critical: 'Crítico', emergency: 'Emergência'
    };
    function resetAlarmForm() {
        editingAlarmId = ''; get<HTMLFormElement>('alarm-form').reset();
        get<HTMLInputElement>('alarm-enabled').checked = true; get<HTMLInputElement>('alarm-activation-delay').value = '0';
        get<HTMLInputElement>('alarm-clear-delay').value = '0'; fillAlarmSelects('', '');
        get<HTMLFormElement>('alarm-form').querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent = 'Cadastrar alarme';
        get<HTMLButtonElement>('alarm-cancel').hidden = true;
        updateAlarmFields();
    }
    function renderAlarms() {
        const output = get<HTMLTableSectionElement>('alarm-list'); output.replaceChildren();
        for (const alarm of view.alarms) {
            const row = document.createElement('tr');
            const title = cell(row, alarm.title); const code = document.createElement('span'); code.className = 'command-code';
            code.textContent = alarm.code; title.prepend(code);
            cell(row, alarm.ihmMachineId ? alarmMachines.find(item => item.ihmMachineId === alarm.ihmMachineId)?.name
                || `Máquina removida (${alarm.ihmMachineId})` : 'Linha completa');
            const signal = view.signals.find(item => item.signalId === alarm.signalId);
            cell(row, `${signal?.label || 'Sinal removido'} · valor ${alarm.activeValues.join(', ')}`);
            cell(row, `${alarmSeverityLabels[alarm.severity]}${alarm.blocksEntry ? ' · bloqueia entradas' : ''}${alarm.requiresAcknowledgment ? ' · exige reconhecimento' : ''}`);
            cell(row, alarm.enabled ? 'Ativo' : 'Inativo');
            const actions = cell(row); actions.className = 'signal-actions';
            actions.append(action('Editar', 'secondary', () => editAlarm(alarm)),
                action('Remover', 'danger', () => void removeAlarm(alarm))); output.append(row);
        }
        if (!view.alarms.length) { const row = document.createElement('tr'); const empty = cell(row, 'Nenhum alarme cadastrado.');
            empty.className = 'table-empty'; empty.colSpan = 6; output.append(row); }
    }
    function editAlarm(alarm: AlarmDefinition) {
        editingAlarmId = alarm.alarmId; get<HTMLInputElement>('alarm-code').value = alarm.code;
        get<HTMLInputElement>('alarm-title').value = alarm.title; fillAlarmSelects(alarm.signalId, alarm.ihmMachineId || '');
        get<HTMLInputElement>('alarm-values').value = alarm.activeValues.join(', ');
        get<HTMLSelectElement>('alarm-severity').value = alarm.severity;
        get<HTMLInputElement>('alarm-description').value = alarm.description || '';
        get<HTMLInputElement>('alarm-instruction').value = alarm.instruction || '';
        get<HTMLInputElement>('alarm-activation-delay').value = String(alarm.activationDelayMs);
        get<HTMLInputElement>('alarm-clear-delay').value = String(alarm.clearDelayMs);
        get<HTMLInputElement>('alarm-blocks-entry').checked = alarm.blocksEntry;
        get<HTMLInputElement>('alarm-ack').checked = alarm.requiresAcknowledgment;
        get<HTMLInputElement>('alarm-enabled').checked = alarm.enabled;
        get<HTMLFormElement>('alarm-form').querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent = 'Salvar alarme';
        get<HTMLButtonElement>('alarm-cancel').hidden = false;
        updateAlarmFields();
        get('alarm-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    async function removeAlarm(alarm: AlarmDefinition) {
        if (!confirm(`Remover o alarme ${alarm.code} · ${alarm.title}?`)) return;
        try { await request('DELETE', `/api/plc-alarms/${alarm.alarmId}`); if (editingAlarmId === alarm.alarmId) resetAlarmForm();
            await refresh(); notice('Alarme removido.'); }
        catch (error) { notice(error instanceof Error ? error.message : 'Remoção do alarme não confirmada.', true); }
    }
    function renderCommands() {
        const output = get<HTMLTableSectionElement>('command-list'); output.replaceChildren();
        for (const command of view.commands) {
            const row = document.createElement('tr'); const title = cell(row, command.label);
            const code = document.createElement('span'); code.className = 'command-code'; code.textContent = command.code || command.commandId; title.prepend(code);
            cell(row, command.scope === 'machine' ? `Máquina ${command.targetMachineId}` : 'Linha');
            cell(row, [deviceName(command.plcId, command.machineId), ...(command.replicaPlcIds ?? []).map(id => deviceName(id))].join(' + '));
            cell(row, `${command.plcAddress} · ${command.commandType} @ ${command.address} = ${command.value}`);
            cell(row, command.ackSignalId
                ? view.signals.find(item => item.signalId === command.ackSignalId)?.label || 'Sinal não encontrado'
                : 'Sem confirmação · somente escrita');
            const actions = cell(row); actions.className = 'signal-actions';
            actions.append(action('Editar', 'secondary', () => editCommand(command)), action('Executar', 'secondary', () => void executeCommand(command)),
                action('Remover', 'danger', () => void removeCommand(command))); output.append(row);
        }
        if (!output.children.length) { const row = document.createElement('tr'); const empty = cell(row, 'Nenhum comando cadastrado.'); empty.className = 'table-empty'; empty.colSpan = 6; }
    }
    function editCommand(command: Command) {
        editingCommandId = command.commandId; get<HTMLSelectElement>('command-device').value = command.plcId || ''; fillAckSignals(command.ackSignalId || '');
        renderReplicaDevices(command.replicaPlcIds ?? []);
        get<HTMLInputElement>('command-code').value = command.code || ''; get<HTMLInputElement>('command-label').value = command.label;
        get<HTMLSelectElement>('command-scope').value = command.scope || 'line'; get<HTMLSelectElement>('command-machine').value = command.targetMachineId || '';
        get<HTMLInputElement>('command-plc-address').value = command.plcAddress; get<HTMLSelectElement>('command-type').value = command.commandType;
        get<HTMLInputElement>('command-address').value = String(command.address); get<HTMLInputElement>('command-value').value = String(command.value);
        get<HTMLSelectElement>('command-mode').value = command.mode || 'maintained';
        get<HTMLInputElement>('command-pulse').value = String(Math.max(600, command.pulseMs ?? 600));
        get<HTMLInputElement>('command-reset-value').value = String(command.resetValue ?? 0);
        get<HTMLInputElement>('command-timeout').value = String(command.ackTimeoutMs);
        get<HTMLInputElement>('command-order').value = String(command.order ?? 0); get<HTMLSelectElement>('command-business-action').value = command.businessAction || 'plc_only';
        get<HTMLInputElement>('command-visible').checked = command.visible !== false;
        get<HTMLInputElement>('command-enabled').checked = command.enabled; renderCommandInterlocks(command); updateCommandFields();
        get<HTMLFormElement>('command-form').querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent = 'Salvar comando';
        get<HTMLButtonElement>('command-cancel').hidden = false;
        get('command-form').scrollIntoView({ behavior:'smooth', block:'center' });
    }
    function resetCommandForm() {
        editingCommandId = ''; get<HTMLFormElement>('command-form').reset();
        get<HTMLInputElement>('command-enabled').checked = true; get<HTMLInputElement>('command-visible').checked = true;
        get<HTMLInputElement>('command-value').value = '1'; get<HTMLInputElement>('command-timeout').value = '5000';
        get<HTMLInputElement>('command-pulse').value = '600'; get<HTMLInputElement>('command-reset-value').value = '0';
        get<HTMLInputElement>('command-order').value = '0'; fillAckSignals(); renderReplicaDevices([]); renderCommandInterlocks();
        get<HTMLFormElement>('command-form').querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent = 'Cadastrar comando';
        get<HTMLButtonElement>('command-cancel').hidden = true; updateCommandFields();
    }
    async function executeCommand(command: Command) {
        if (!confirm(`Solicitar à CLP: ${command.label}?`)) return;
        try { const result = await request<{ warning?: string }>('POST', `/api/plc-commands/${command.commandId}/execute`, {});
            notice(result.warning || 'Comando confirmado pelas CLPs.'); }
        catch (error) { notice(error instanceof Error ? error.message : 'Comando não confirmado.', true); }
    }
    async function removeCommand(command: Command) {
        if (!confirm(`Remover o comando ${command.label}?`)) return;
        try { await request('DELETE', `/api/plc-commands/${command.commandId}`);
            if (editingCommandId === command.commandId) resetCommandForm(); await refresh(); notice('Comando removido.'); }
        catch (error) { notice(error instanceof Error ? error.message : 'Remoção não confirmada.', true); }
    }
    function applyStates(states: SignalState[]) {
        for (const signal of view.signals) {
            const target = document.querySelector<HTMLElement>(`[data-signal-state="${signal.signalId}"]`); if (!target) continue;
            const state = states.find(item => item.signalId === signal.signalId); target.replaceChildren();
            const dot = document.createElement('span'); dot.className = `live-dot ${state?.error ? 'error' : state?.active ? 'active' : 'normal'}`;
            const text = document.createElement('span'); text.className = 'live-value';
            text.textContent = state ? state.error ? 'Erro de leitura' : `${String(state.value)} · ${state.active ? 'ATIVO' : 'normal'}` : 'Aguardando leitura';
            target.append(dot, text); if (state?.error) target.title = state.error;
        }
    }
    async function loadStates() { if (!token) return; try { applyStates(await request('GET', '/api/plc-signals/states')); } catch { /* mantém o último valor visível */ } }
    async function refresh() {
        [view, alarmMachines] = await Promise.all([request<View>('GET', '/api/plc-signals'),
            request<IhmMachine[]>('GET', '/api/ihm-machines/configuration')]);
        fillDeviceSelects(); renderDevices(); renderSignals(); renderAlarms(); renderCommands();
        if (!editingCommandId) renderCommandInterlocks(); await loadStates();
    }
    async function loadDowntimeReasons() {
        const select = get<HTMLSelectElement>('signal-downtime-reason'); select.replaceChildren(); option(select, '', 'Selecione um motivo');
        const reasons = await request<DowntimeReason[]>('GET', '/api/availability/reasons');
        for (const reason of reasons.filter(item => item.active)) option(select, reason.reasonId, `${reason.code} · ${reason.name}`);
    }
    function updateBehavior() {
        const oee = value('signal-behavior') === 'record_stop' || value('signal-on-activate') === 'line_stopped'
            || value('signal-on-deactivate') === 'line_stopped'; get('reason-field').hidden = !oee;
        get<HTMLSelectElement>('signal-downtime-reason').required = oee;
    }
    function logout() {
        token = ''; window.clearInterval(stateTimer); get('login-panel').hidden = false; get('content-panel').hidden = true;
        get('connection-dot').className = 'dot'; get('admin-status').textContent = 'Acesso ADMIN necessário';
    }

    get<HTMLFormElement>('admin-login-form').onsubmit = event => { event.preventDefault();
        const submit = beginSubmit(event.currentTarget as HTMLFormElement); if (!submit) return; void (async () => {
        try {
            token = (await request<{ token: string }>('POST', '/api/admin/sessions', { password: value('admin-password') }, false)).token;
            await loadDowntimeReasons(); await refresh(); get('login-panel').hidden = true; get('content-panel').hidden = false;
            get('connection-dot').className = 'dot green'; get('admin-status').textContent = 'Sessão ADMIN ativa';
            window.clearInterval(stateTimer); stateTimer = window.setInterval(() => void loadStates(), 1000);
        } catch (error) { get('admin-status').textContent = error instanceof Error ? error.message : 'Autenticação não confirmada.'; }
        finally { submit.disabled = false; }
    })(); };
    get<HTMLFormElement>('device-form').onsubmit = event => { event.preventDefault();
        const submit = beginSubmit(event.currentTarget as HTMLFormElement); if (!submit) return; void (async () => {
        try {
            const path = editingDeviceId ? `/api/plc-devices/${editingDeviceId}` : '/api/plc-devices';
            await request(editingDeviceId ? 'PUT' : 'POST', path, { name: value('device-name'), host: value('device-host'),
                port: Number(value('device-port')), unitId: Number(value('device-unit')), timeoutMs: Number(value('device-timeout')),
                enabled: check('device-enabled') });
            resetDeviceForm(); await refresh(); notice('CLP salva.');
        } catch (error) { notice(error instanceof Error ? error.message : 'Cadastro da CLP não confirmado.', true); }
        finally { submit.disabled = false; }
    })(); };
    get<HTMLFormElement>('signal-form').onsubmit = event => { event.preventDefault();
        const submit = beginSubmit(event.currentTarget as HTMLFormElement); if (!submit) return; void (async () => {
        try {
            const behavior = value('signal-behavior');
            const path = editingSignalId ? `/api/plc-signals/${editingSignalId}` : '/api/plc-signals';
            await request(editingSignalId ? 'PUT' : 'POST', path, { plcId: value('signal-device'), label: value('signal-label'),
                plcAddress: value('signal-plc-address'), readType: value('signal-read-type'), address: Number(value('signal-address')),
                ...(value('signal-bit') ? { bit: Number(value('signal-bit')) } : { triggerValue: Number(value('signal-trigger-value')) }),
                pollingMs: Number(value('signal-polling')),
                severity: value('signal-severity'), behavior,
                onActivateAction: value('signal-on-activate'), onDeactivateAction: value('signal-on-deactivate'),
                ...(behavior === 'record_stop' || value('signal-on-activate') === 'line_stopped'
                    || value('signal-on-deactivate') === 'line_stopped' ? { downtimeReasonId: value('signal-downtime-reason') } : {}),
                activeValue: check('signal-active-value'), requiresAcknowledgment: false, enabled: check('signal-enabled'),
                aggregateStatusMappings: aggregateStatusMappings(),
                ...(check('signal-machine-status') ? { machineStatus: { ihmMachineId: value('signal-status-machine'),
                    mappings: machineStatusMappings() } } : {}) });
            resetSignalForm(); await refresh(); notice('Sinal cadastrado.');
        } catch (error) { notice(error instanceof Error ? error.message : 'Cadastro não confirmado.', true); }
        finally { submit.disabled = false; }
    })(); };
    get<HTMLFormElement>('command-form').onsubmit = event => { event.preventDefault();
        const submit = beginSubmit(event.currentTarget as HTMLFormElement); if (!submit) return; void (async () => {
        try {
            const path = editingCommandId ? `/api/plc-commands/${editingCommandId}` : '/api/plc-commands';
            const mode = value('command-mode'), scope = value('command-scope');
            await request(editingCommandId ? 'PUT' : 'POST', path, { plcId: value('command-device'), replicaPlcIds: selectedReplicaPlcs(), code: value('command-code').toUpperCase(), label: value('command-label'),
                scope, ...(scope === 'machine' ? { targetMachineId:value('command-machine') } : {}),
                plcAddress: value('command-plc-address'), commandType: value('command-type'), address: Number(value('command-address')),
                value: Number(value('command-value')), ackSignalId: value('command-ack'), ackTimeoutMs: Number(value('command-timeout')),
                mode, ...(mode === 'pulse' ? { pulseMs:Number(value('command-pulse')), resetValue:Number(value('command-reset-value')) } : {}),
                visible:check('command-visible'),
                order:Number(value('command-order')), businessAction:value('command-business-action'), interlocks:commandInterlocks(),
                enabled: check('command-enabled') });
            resetCommandForm(); await refresh(); notice('Comando cadastrado.');
        } catch (error) { notice(error instanceof Error ? error.message : 'Cadastro não confirmado.', true); }
        finally { submit.disabled = false; }
    })(); };
    get<HTMLFormElement>('alarm-form').onsubmit = event => { event.preventDefault();
        const submit = beginSubmit(event.currentTarget as HTMLFormElement); if (!submit) return; void (async () => {
        try {
            const activeValues = value('alarm-values').split(/[,;\s]+/).filter(Boolean).map(item => Number(item));
            if (!activeValues.length || activeValues.some(item => !Number.isInteger(item) || item < 0 || item > 65535)) {
                throw new Error('Informe valores inteiros entre 0 e 65535, separados por vírgula.');
            }
            const signal = view.signals.find(item => item.signalId === value('alarm-signal'));
            if (signal && (['coil', 'discrete_input'].includes(signal.readType) || signal.bit !== undefined)
                && activeValues.some(item => item !== 0 && item !== 1)) {
                throw new Error('Este sinal é booleano. Use somente os valores 0 e 1.');
            }
            const path = editingAlarmId ? `/api/plc-alarms/${editingAlarmId}` : '/api/plc-alarms';
            await request(editingAlarmId ? 'PUT' : 'POST', path, { code: value('alarm-code').toUpperCase(),
                title: value('alarm-title'), signalId: value('alarm-signal'), ihmMachineId: value('alarm-machine'),
                activeValues, severity: value('alarm-severity'), description: value('alarm-description'),
                instruction: value('alarm-instruction'), activationDelayMs: Number(value('alarm-activation-delay')),
                clearDelayMs: Number(value('alarm-clear-delay')), blocksEntry: check('alarm-blocks-entry'),
                requiresAcknowledgment: check('alarm-ack'), enabled: check('alarm-enabled') });
            resetAlarmForm(); await refresh(); notice('Alarme salvo.');
        } catch (error) { notice(error instanceof Error ? error.message : 'Cadastro do alarme não confirmado.', true); }
        finally { submit.disabled = false; }
    })(); };
    function updateCommandFields() {
        const machineScope = value('command-scope') === 'machine';
        get('command-machine-field').hidden = !machineScope;
        get<HTMLSelectElement>('command-machine').required = machineScope;
        const pulse = value('command-mode') === 'pulse';
        document.querySelectorAll<HTMLElement>('.command-pulse-field').forEach(item => {
            item.hidden = !pulse; item.querySelectorAll<HTMLInputElement>('input').forEach(input => input.disabled = !pulse);
        });
        const hasAck = !!value('command-ack'), timeout = get<HTMLInputElement>('command-timeout');
        timeout.disabled = !hasAck; timeout.parentElement?.classList.toggle('field-disabled', !hasAck);
        const coil = value('command-type') === 'coil';
        for (const id of ['command-value', 'command-reset-value']) {
            const input = get<HTMLInputElement>(id); input.max = coil ? '1' : '65535';
            if (coil && Number(input.value) > 1) input.value = '1';
        }
    }
    function updateAlarmFields() {
        const signal = view.signals.find(item => item.signalId === value('alarm-signal'));
        const booleanSignal = !!signal && (['coil', 'discrete_input'].includes(signal.readType) || signal.bit !== undefined);
        const values = get<HTMLInputElement>('alarm-values'); values.placeholder = booleanSignal ? '0, 1' : 'Ex.: 1, 2, 5';
        values.title = booleanSignal ? 'Para este sinal, informe somente 0 e/ou 1.' : 'Informe valores inteiros separados por vírgula.';
    }
    get('signal-behavior').onchange = updateBehavior; get('signal-on-activate').onchange = updateBehavior;
    get('signal-on-deactivate').onchange = updateBehavior;
    get('signal-read-type').onchange = updateSignalFields; get('signal-bit').oninput = updateSignalFields;
    get('command-device').onchange = () => { fillAckSignals(); renderReplicaDevices(); updateCommandFields(); };
    get('signal-aggregate-status').onchange = updateAggregateStatusFields;
    get('signal-machine-status').onchange = updateMachineStatusFields;
    get('add-aggregate-status').onclick = () => {
        const existing = get('aggregate-status-mappings').children.length ? aggregateStatusMappings() : [];
        renderAggregateStatusMappings([...existing, { value: existing.length,
            label: `Estado ${existing.length}`, color: 'gray', blocksEntry: false }]);
        updateAggregateStatusFields(); updateSignalFields();
    };
    get('add-machine-status').onclick = () => {
        const existing = get('machine-status-mappings').children.length ? machineStatusMappings() : [];
        renderMachineStatusMappings([...existing, { value: existing.length, label: `Estado ${existing.length}`, color: 'gray' }]);
        updateMachineStatusFields(); updateSignalFields();
    };
    get('command-scope').onchange = updateCommandFields; get('command-mode').onchange = updateCommandFields;
    get('command-type').onchange = updateCommandFields; get('command-ack').onchange = updateCommandFields;
    get('alarm-signal').onchange = updateAlarmFields;
    get('device-cancel').onclick = resetDeviceForm; get('signal-cancel').onclick = resetSignalForm;
    get('command-cancel').onclick = resetCommandForm;
    get('alarm-cancel').onclick = resetAlarmForm;
    get('admin-exit').onclick = logout; renderAggregateStatusMappings(); renderMachineStatusMappings();
    updateBehavior(); updateSignalFields(); updateAggregateStatusFields(); updateMachineStatusFields();
    updateCommandFields(); updateAlarmFields();
})();
