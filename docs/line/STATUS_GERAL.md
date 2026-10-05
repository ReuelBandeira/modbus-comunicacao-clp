# Status geral da linha

A faixa exibida abaixo do cabeçalho de todas as telas é alimentada por um sinal Modbus configurado em **Configurações → Sinais e comandos CLP**.

No cadastro ou edição do sinal:

1. Marque **Usar como status geral da linha**.
2. Adicione os valores publicados pela CLP.
3. Informe o texto operacional e a cor de cada valor.
4. Salve o sinal e mantenha seu monitoramento ativo.

Exemplo de mapeamento:

| Valor CLP | Texto | Cor |
|---:|---|---|
| 0 | Linha parada | Vermelho |
| 1 | Em produção | Verde |
| 2 | Atenção | Amarelo |
| 3 | Preparação | Azul |
| 4 | Sem programação | Cinza |

Somente um sinal ativo pode controlar a faixa. A aplicação consulta `GET /api/line-status` a cada dois segundos. Valores ainda não mapeados aparecem em cinza como `Estado N`; falhas de leitura ou comunicação aparecem em vermelho.
