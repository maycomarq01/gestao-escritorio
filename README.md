# Gestão do escritório

Controle de clientes, atividades, prazos e documentos faltando, com avisos dentro do aplicativo, tela de reunião e uma página privada para cada cliente.

## Rodar no computador

Precisa do Node.js 22 ou mais novo.

```bash
npm install
```

```bash
npm start
```

Abra http://localhost:3000. No primeiro acesso, crie o usuário administrador. Sem configuração, os dados ficam em um arquivo na pasta `data`.

## Publicar online de graça

O aplicativo roda no plano grátis da Render, e os dados ficam em um banco no plano grátis do Turso.

1. Crie um banco no Turso e gere um token de acesso.
2. Crie o serviço na Render a partir do repositório. O arquivo `render.yaml` já traz a configuração.
3. Preencha `DATABASE_URL` com o endereço do banco e `DATABASE_TOKEN` com o token.
4. Abra o endereço gerado e crie o administrador imediatamente, porque o primeiro acesso fica aberto até isso ser feito.

Limites do plano grátis da Render:

- O serviço dorme depois de 15 minutos sem acesso e leva cerca de um minuto para acordar.
- Sem atualização automática por repositório conectado, cada nova versão precisa ser publicada manualmente.

Nunca coloque o token no repositório, porque ele é público. Faça cópias de segurança dos dados periodicamente.

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
