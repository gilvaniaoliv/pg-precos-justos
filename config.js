/**
 * ============================================================================
 * ARQUIVO DE CONFIGURAÇÃO DA LOJA - P&G PREÇOS JUSTOS
 * ============================================================================
 * Este é o ÚNICO arquivo que você precisa editar para configurar:
 * 1. A conexão com o Supabase (URL e Chave Pública / anon)
 * 2. O nome da loja, WhatsApp e Instagram
 * 3. Taxas do Mercado Pago (Pix e Cartão) e textos da loja
 *
 * ⚠️ REGRA DE SEGURANÇA IMPORTANTE:
 * Use SOMENTE a chave "anon" (public) do Supabase abaixo.
 * NUNCA coloque a chave "service_role" neste arquivo ou em qualquer arquivo do site!
 */

window.LOJA_CONFIG = {
  // ==========================================================================
  // 1. DADOS DO SUPABASE
  // ==========================================================================
  SUPABASE_URL: "https://qxorswheoxrklezbcpjr.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF4b3Jzd2hlb3hya2xlemJjcGpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM1NjYzMjAsImV4cCI6MjEwOTE0MjMyMH0.P-3Jl-wCP0Wz-Eg2PCc1tsAYxdhP3DKNsGzKkrTZJmA",

  // Nome do bucket de imagens criado pelo script sql/setup.sql
  STORAGE_BUCKET: "produtos-fotos",

  // ==========================================================================
  // 2. DADOS DA SUA LOJA
  // ==========================================================================
  NOME_LOJA: "P&G Preços Justos",
  SLOGAN: "Produtos variados com preços na média do mercado ou abaixo!",

  // Número do WhatsApp (usado para tirar dúvidas dos clientes):
  WHATSAPP_NUMERO: "5571999915480",
  WHATSAPP_EXIBICAO: "(71) 99991-5480",

  // Instagram da loja
  INSTAGRAM_USUARIO: "precosjustos.pg",
  INSTAGRAM_URL: "https://instagram.com/precosjustos.pg",

  // Texto do banner principal no topo da vitrine
  BANNER_TAG: "Compra Rápida e Segura",
  BANNER_TITULO: "Preços na média do mercado ou abaixo, sem truques!",
  BANNER_SUBTITULO:
    "Compre direto pelo site: escolha retirada grátis ou entrega em casa com cálculo automático da taxa e pague via Pix ou Cartão (sincronizado com Mercado Pago / Mercado Livre). Dúvidas? Chame no WhatsApp!",

  // ==========================================================================
  // 3. MERCADO PAGO / MERCADO LIVRE E TAXAS DE PAGAMENTO
  // ==========================================================================
  TAXA_PIX_PCT: 0, // Pix = 0% de taxa para o cliente
  TAXA_CARTAO_MERCADO_PAGO_PCT: 4.99, // Taxa padrão de cartão no Mercado Pago (%)
  PIX_CHAVE_LOJA: "5571999915480", // Chave Pix (Celular/CNPJ/E-mail) sincronizada com a conta Mercado Pago
  PIX_FAVORECIDO: "P&G Preços Justos",
  PIX_CIDADE: "SALVADOR",
  MERCADO_PAGO_PUBLIC_KEY: "", // Opcional: Public Key do Mercado Pago (também editável no /admin)
  MERCADO_PAGO_ACCESS_TOKEN: "", // Opcional: configurável localmente no painel /admin
  ENDERECO_RETIRADA_LOJA: "Salvador - BA (Horário agendado após confirmação do pagamento)",

  // ==========================================================================
  // 4. REGRAS DE EXIBIÇÃO E SEGURANÇA
  // ==========================================================================
  DIAS_VALIDADE_PESQUISA: 60, // Alerta no /admin após 60 dias
  DESCONTO_MINIMO_ECONOMIA_PCT: 5,
  LIMITE_ESTOQUE_BAIXO: 3, // Estoque < 3 (1 ou 2) mostra "Últimas unidades"
  TEMPO_INATIVIDADE_ADMIN_MINUTOS: 30 // Desloga do painel /admin após 30 min sem mexer
};
