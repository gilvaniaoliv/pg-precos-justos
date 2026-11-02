/**
 * ============================================================================
 * ARQUIVO DE CONFIGURAÇÃO DA LOJA - P&G PREÇOS JUSTOS
 * ============================================================================
 * Este é o ÚNICO arquivo que você precisa editar para configurar:
 * 1. A conexão com o Supabase (URL e Chave Pública / anon)
 * 2. O nome da loja, WhatsApp e Instagram
 * 3. Textos de aviso e tempo de sessão do painel administrativo
 *
 * ⚠️ REGRA DE SEGURANÇA IMPORTANTE:
 * Use SOMENTE a chave "anon" (public) do Supabase abaixo.
 * NUNCA coloque a chave "service_role" neste arquivo ou em qualquer arquivo do site!
 */

window.LOJA_CONFIG = {
  // ==========================================================================
  // 1. DADOS DO SUPABASE (Substitua pelos dados do seu projeto no Supabase)
  // Em: Project Settings -> API -> Project URL e Project API Keys (anon public)
  // ==========================================================================
  SUPABASE_URL: "https://qxorswheoxrklezbcpjr.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF4b3Jzd2hlb3hya2xlemJjcGpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM1NjYzMjAsImV4cCI6MjEwOTE0MjMyMH0.P-3Jl-wCP0Wz-Eg2PCc1tsAYxdhP3DKNsGzKkrTZJmA",

  // Nome do bucket de imagens criado pelo script sql/setup.sql
  STORAGE_BUCKET: "produtos-fotos",

  // ==========================================================================
  // 2. DADOS DA SUA LOJA (Edite aqui quando precisar mudar nome ou contatos)
  // ==========================================================================
  NOME_LOJA: "P&G Preços Justos",
  SLOGAN: "Produtos variados com preços na média do mercado ou abaixo!",

  // Número do WhatsApp: código do país (55) + DDD (71) + número (só números, sem espaços)
  WHATSAPP_NUMERO: "5571999915480",
  WHATSAPP_EXIBICAO: "(71) 99991-5480",

  // Instagram da loja (sem o @ no campo usuario, ou como preferir exibir)
  INSTAGRAM_USUARIO: "precosjustos.pg",
  INSTAGRAM_URL: "https://instagram.com/precosjustos.pg",

  // Texto do banner principal no topo da vitrine
  BANNER_TAG: "Catálogo Oficial",
  BANNER_TITULO: "Preços na média do mercado ou abaixo, com total transparência.",
  BANNER_SUBTITULO:
    "Consulte nossa pesquisa de mercado em cada item, adicione os produtos desejados à sua lista e finalize o atendimento diretamente pelo WhatsApp.",

  // ==========================================================================
  // 3. REGRAS DE EXIBIÇÃO E SEGURANÇA (Não precisa alterar, já seguem seu pedido)
  // ==========================================================================
  DIAS_VALIDADE_PESQUISA: 60, // Acima de 60 dias, o preço médio não é exibido na vitrine
  DESCONTO_MINIMO_ECONOMIA_PCT: 5, // Exibe "Economize R$ X" quando for >= 5% abaixo da média
  LIMITE_ESTOQUE_BAIXO: 3, // Estoque < 3 (1 ou 2) mostra "Últimas unidades"
  TEMPO_INATIVIDADE_ADMIN_MINUTOS: 30 // Desloga do painel /admin após 30 min sem mexer
};

