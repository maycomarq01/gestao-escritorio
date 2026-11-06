# Gestão do escritório

Controle de clientes, atividades, prazos e documentos faltando, com avisos dentro do aplicativo, tela de reunião e uma página privada para cada cliente.

## Rodar no computador

Precisa do Node.js 22.13 ou mais novo. Não há dependências para instalar.

```bash
npm start
```

Abra http://localhost:3000. No primeiro acesso, crie o usuário administrador.

## Publicar online

O aplicativo precisa de um serviço que rode Node.js e tenha disco permanente, porque os dados ficam em um arquivo SQLite. Render e Railway são duas opções, e o disco permanente normalmente é pago.

1. Coloque esta pasta em um repositório no GitHub.
2. Crie o serviço apontando para o repositório, com o comando de início `npm start`.
3. Crie um disco permanente, por exemplo em `/data`.
4. Defina a variável `DATA_DIR` com esse caminho.
5. Abra o endereço gerado e crie o administrador imediatamente, porque o primeiro acesso fica aberto até isso ser feito.

Sem o disco permanente, os dados são apagados a cada atualização do serviço. Faça cópias de segurança da pasta de dados.

## Instalar no celular

Depois de publicado, com o endereço `https`:

- **iPhone:** abra no Safari, toque em Compartilhar e depois em Adicionar à Tela de Início.
- **Android:** abra no Chrome, abra o menu e toque em Instalar aplicativo ou Adicionar à tela inicial.

## Como os avisos funcionam

- Um item entra nos avisos quando está atrasado, vence hoje ou está dentro dos dias de antecedência definidos nele.
- A equipe vê os avisos ao abrir o aplicativo. Nada é enviado para fora, e o celular não recebe notificação.
- "Meus" mostra os itens da pessoa e os sem responsável. "Visto" esconde o aviso até o prazo mudar.
- O dia semanal de revisão é definido em Equipe, e a próxima reunião ao encerrar uma reunião.

## Página do cliente

Cada cliente tem um link privado, sem senha, em que aparecem só os itens marcados como "Mostrar na página do cliente". Quem tiver o link consegue ver a página, então use "Trocar o link" se ele for compartilhado por engano.
