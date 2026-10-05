# Disponibilidade e OEE

O módulo registra paradas manualmente e mantém a estrutura preparada para eventos futuros da CLP.
Os fatos são persistidos; os percentuais são calculados na consulta e não ficam gravados como valores soltos.

## Configuração inicial

1. Cadastre e ative os turnos em **Configurações > Turnos**.
2. Acesse **Configurações > Disponibilidade e OEE** com a senha ADMIN.
3. Cadastre os motivos de parada e indique se cada motivo reduz a disponibilidade.
4. Cadastre pausas e intervalos que devem ser excluídos do tempo planejado.
5. Adicione exceções de calendário para feriados, cancelamentos ou produção extraordinária.
6. Configure o **tempo de ciclo ideal por chip** em segundos. Esse valor habilita Performance e OEE Geral.

Execute `npm.cmd run db:migrate` após atualizar uma instalação existente. A inicialização da API também garante os índices de forma idempotente.

## Operação

Na tela **OEE**, use **Registrar parada** para abrir a área operacional em tela cheia, selecione o motivo
e confirme o apontamento. Quando a linha voltar a produzir, use **Retomar produção**. Os horários são
definidos pelo servidor e as requisições são idempotentes.

O painel atualiza estado, tempos, qualidade, eventos e Pareto automaticamente a cada três segundos quando
**Tempo real** está marcado. Também é possível consultar o turno atual, o dia, as últimas 24 horas ou um
período personalizado de até 93 dias.

O gráfico **Cascata do tempo produtivo** acompanha o mesmo período selecionado e detalha a passagem do
tempo programado pelos descontos de pausas, eventos excluídos e paradas computadas até chegar ao tempo
efetivamente em operação. Eventos configurados para não afetar a disponibilidade aparecem como exclusão;
paradas que afetam o indicador aparecem como perda de disponibilidade.

Enquanto a CLP ainda não estiver integrada, a linha é considerada produtiva durante o tempo planejado sempre que não existir uma parada aberta.
Fora de um turno ativo, a tela mostra **Fora de turno** e o tempo não compõe a disponibilidade.

## Cálculo

```text
Tempo planejado = turnos do período - pausas - cancelamentos - eventos excluídos
Tempo em operação = tempo planejado - paradas que afetam disponibilidade
Disponibilidade = tempo em operação / tempo planejado
Qualidade = chips aprovados / chips produzidos
```

Sem tempo de ciclo ideal, Performance e OEE permanecem indisponíveis. Com o valor configurado:

```text
Performance = produção real / produção teórica
OEE = Disponibilidade × Performance × Qualidade
```

## Persistência

- `pcm_downtime_reasons`: catálogo de motivos;
- `pcm_shift_breaks`: pausas recorrentes dos turnos;
- `pcm_production_calendar`: exceções por data, linha e turno;
- `pcm_downtime_events`: início, fim, motivo, regra de impacto e origem da parada.
- `pcm_production_periods`: snapshot do turno, calendário e pausas efetivos em cada ocorrência.
- `pcm_oee_configurations`: tempo de ciclo ideal configurado para cada linha.

Cada evento guarda um snapshot do motivo e cada período guarda o planejamento vigente. Por isso, alterações
futuras em turnos, pausas e calendário não mudam relatórios históricos já materializados.
Motivos já utilizados não podem ser removidos; devem ser inativados.
