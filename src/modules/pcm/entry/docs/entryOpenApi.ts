const serialSchema = { type:'string', minLength:1, maxLength:512, pattern:'^[^\\s\\x00-\\x1f\\x7f]+$', example:'BANDEJA-001' };
const errorResponse=(description:string,msg:string)=>({description,content:{'application/json':{schema:{$ref:'#/components/schemas/ApiError'},example:{status:'ERROR',msg}}}});
const idParameter={name:'entryId',in:'path',required:true,schema:{type:'string',format:'uuid'}};
const inputBody={required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/EntryRequestDto'}}}};

export const entrySchemas = {
    EntryRequestDto:{description:'Informe exatamente serial-number ou qr-code. requestId opcional torna tentativas repetidas idempotentes.',oneOf:[
        {type:'object',required:['serial-number'],properties:{'serial-number':serialSchema,requestId:{type:'string'}}},
        {type:'object',required:['qr-code'],properties:{'qr-code':serialSchema,requestId:{type:'string'}}}
    ]},
    EntryPreparation:{type:'object',required:['entryId','serialNumber','preparation'],properties:{
        entryId:{type:'string',format:'uuid'},serialNumber:serialSchema,enteredAt:{type:'string',format:'date-time'},
        preparation:{type:'object',required:['status','chips'],properties:{status:{type:'string',enum:['scanning','ready','released','cancelled']},chips:{type:'array',maxItems:20,items:{type:'object',required:['position','serialNumber','scannedAt'],properties:{position:{type:'integer',minimum:1,maximum:20},serialNumber:serialSchema,scannedAt:{type:'string',format:'date-time'}}}}}}
    }}
};

export const entryPaths = {
    '/api/serial-numbers':{post:{tags:['Entrada PCM'],operationId:'startPcmPreparationLegacy',summary:'Iniciar preparação (endpoint compatível)',description:'Identifica a bandeja, mas não a libera. A entrada na linha ocorre somente após 20 chips e a chamada de release.',requestBody:inputBody,responses:{
        '200':{description:'Preparação iniciada ou retomada.'},'400':errorResponse('Entrada inválida.','Informe apenas um campo: serial-number ou qr-code.'),'409':errorResponse('Conflito.','Já existe uma bandeja em preparação nesta estação.'),'413':errorResponse('Corpo acima de 32 KB.','Corpo da requisição excede 32 KB.'),'415':errorResponse('Tipo inválido.','Use Content-Type: application/json.'),'500':errorResponse('Erro HTTP.','Erro interno.'),'503':errorResponse('Banco indisponível.','Não foi possível confirmar o registro no MongoDB.')
    }}},
    '/api/entry-preparation/current':{get:{tags:['Entrada PCM'],summary:'Consultar preparação ativa da estação',responses:{'200':{description:'Preparação ativa ou null.'},'503':errorResponse('Indisponível.','Preparação de bandejas indisponível sem MongoDB e linha configurada.')}}},
    '/api/entry-preparation/tray':{post:{tags:['Entrada PCM'],summary:'Iniciar preparação da bandeja',description:'Exige a quantidade mínima de operadores ativos configurada na linha.',requestBody:inputBody,responses:{'201':{description:'Preparação criada.'},'400':errorResponse('QR inválido.','QR da bandeja inválido.'),'409':errorResponse('Conflito ou equipe incompleta.','Bipagem bloqueada: quantidade mínima de operadores não atingida.')}}},
    '/api/entry-preparation/{entryId}/chips':{post:{tags:['Entrada PCM'],summary:'Gravar chip na próxima posição',parameters:[idParameter],requestBody:inputBody,responses:{'200':{description:'Chip persistido.'},'409':errorResponse('Duplicidade ou estado inválido.','Este chip já foi lido nesta bandeja.')}}},
    '/api/entry-preparation/{entryId}/chips/last':{delete:{tags:['Entrada PCM'],summary:'Desfazer a última leitura',parameters:[idParameter],responses:{'200':{description:'Último chip removido.'}}}},
    '/api/entry-preparation/{entryId}/release':{post:{tags:['Entrada PCM'],summary:'Finalizar e liberar para a linha',parameters:[idParameter],responses:{'200':{description:'Workflow criado e bandeja liberada.'},'409':errorResponse('Incompleta.','A bandeja só pode ser liberada após as 20 posições.')}}},
    '/api/entry-preparation/{entryId}':{delete:{tags:['Entrada PCM'],summary:'Cancelar preparação',parameters:[idParameter],responses:{'200':{description:'Preparação cancelada sem apagar o histórico.'}}}}
};
