# P&G Preços Justos — Loja virtual

Loja virtual para venda ao consumidor final em Salvador–BA, com vitrine pública, carrinho, cadastro de clientes e um painel administrativo completo para gestão de produtos, estoque, vendas e entregas.

**Acesse:** [loja.pgprecosjustos.workers.dev](https://loja.pgprecosjustos.workers.dev/) · **Status:** em desenvolvimento

---

## Funcionalidades

### Vitrine (cliente)
- Catálogo por categorias e subcategorias, com busca, várias fotos por produto e grade otimizada para celular.
- Indicação de estoque: **"Últimas unidades"** (menos de 3) e **"Esgotado"** (botão desativado).
- Preço médio de mercado exibido só quando a pesquisa tem até 60 dias e o preço da loja está abaixo da média.
- Carrinho com **retirada** ou **entrega em casa**, com frete calculado por bairro e cidade.
- **Compra direta no site** com Pix (copia e cola) ou cartão via Mercado Pago, com taxa de pagamento calculada; o pedido também é enviado pelo **WhatsApp**.
- Cadastro e login de clientes, com **verificação de idade** para produtos +18 a partir da data de nascimento.
- **Avaliações** de produtos pelos clientes.
- **App instalável** no celular (PWA), com cache para carregamento rápido, e SEO com `sitemap.xml` e `robots.txt`.

### Painel administrativo (`/admin`)
- Login exclusivo dos administradores, com encerramento automático da sessão por inatividade.
- Cadastro de produtos com upload de fotos, preço de venda, custo, preço mínimo de negociação e pesquisa de mercado.
- Ajuste rápido de estoque e ativação/desativação de produtos.
- Registro de vendas com cálculo de lucro (taxas e frete) e alerta de venda abaixo do preço mínimo.
- Relatório mensal e exportação de vendas e clientes para Excel/CSV.
- Gestão de categorias (com arquivamento) e de áreas de entrega.

---

## Tecnologias

| Camada | Tecnologias |
| --- | --- |
| Front-end | HTML, CSS e JavaScript puro (sem framework) |
| Back-end e banco | Supabase — PostgreSQL, Auth, Storage e funções SQL (RPC) |
| Segurança | Row Level Security (RLS), views públicas, senhas com bcrypt (pgcrypto) |
| Publicação | Cloudflare Workers (site estático) |
| App | PWA — `manifest.webmanifest` e Service Worker |
| Testes | Node.js (script próprio, sem dependências) |

---

## Arquitetura e segurança

O site é estático e conversa direto com o Supabase usando apenas a chave pública (`anon`). Toda a proteção dos dados fica no banco:

- **Visitantes** só leem a view `produtos_publicos`, que não contém custo, preço mínimo nem fontes de pesquisa, e só mostra produtos ativos.
- A tabela completa de **produtos**, as **vendas** e os **clientes** ficam bloqueadas para visitantes (`REVOKE ALL` + políticas RLS).
- **Vendas** são registradas por uma função SQL (`registrar_venda_admin`) que bloqueia a linha do produto durante a transação, evitando estoque incorreto, e só pode ser executada por administradores.
- **Pedidos** feitos na vitrine entram por uma função SQL própria (`registrar_pedido_vitrine`); a tabela de pedidos fica bloqueada para leitura pública.
- **Avaliações** podem ser lidas e enviadas por visitantes, mas só os administradores editam ou apagam.
- **Clientes da vitrine** ficam em tabela própria, com senha criptografada (bcrypt). O Supabase Auth é reservado para os administradores.
- **Fotos**: leitura pública; upload, edição e exclusão só para administradores, com limite de 5 MB e tipos de imagem permitidos.
- O front-end insere os textos vindos do banco como texto puro (`textContent`), evitando **XSS**.

---

## Estrutura

```
├── index.html            # Vitrine
├── app.js                # Lógica da vitrine, carrinho e conta do cliente
├── style.css
├── config.js             # Configuração (Supabase, WhatsApp, Instagram, regras)
├── sw.js                 # Service Worker (PWA)
├── manifest.webmanifest
├── admin/                # Painel administrativo
├── sql/setup.sql         # Tabelas, views, funções e políticas de segurança
├── tests/run-tests.js    # Testes automatizados
├── robots.txt, sitemap.xml
└── img/                  # Logos e ícones
```

---

## Como rodar localmente

1. Clone o repositório:
   ```bash
   git clone https://github.com/gilvaniaoliv/pg-precos-justos.git
   cd pg-precos-justos
   ```
2. Sirva a pasta com qualquer servidor estático:
   ```bash
   npx serve .
   ```
3. Abra `http://localhost:3000`. Sem Supabase configurado, a loja funciona em **modo demonstração**, com produtos de exemplo.

### Conectar ao Supabase (opcional)
1. Crie um projeto no [Supabase](https://supabase.com) e rode `sql/setup.sql` no SQL Editor.
2. Em `config.js`, preencha `SUPABASE_URL` e `SUPABASE_ANON_KEY` (use **apenas** a chave `anon`, nunca a `service_role`).
3. Crie o usuário administrador em **Authentication → Users** e acesse `/admin`.

---

## Testes

```bash
node tests/run-tests.js
```

São 13 testes que verificam:
- ausência da chave `service_role` no código;
- políticas de acesso no banco (o que visitantes podem e não podem ler ou alterar);
- regras de exibição do preço médio de mercado;
- regras de estoque;
- proteção contra XSS.

---

Desenvolvido por **Gilvania de Oliveira Santos** · [LinkedIn](https://www.linkedin.com/in/gilvania-santos-94a18438a) · [GitHub](https://github.com/gilvaniaoliv)
Contribuições de [pedrodsilval](https://github.com/pedrodsilval).
