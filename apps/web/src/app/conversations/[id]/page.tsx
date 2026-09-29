import { getConversation } from "@cnote/enquiry";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Card, CardBody, Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DealReport } from "@/features/enquiry/deal-report";
import { MessageForm } from "@/features/enquiry/message-form";
import { MessageThread } from "@/features/enquiry/conversation";

export const metadata: Metadata = { title: "Conversation" };

export default async function ConversationPage(props: PageProps<"/conversations/[id]">) {
  const { id } = await props.params;
  const s = await requireBusiness(`/conversations/${id}`);
  const convo = await getConversation(actorOf(s), id);
  if (!convo) notFound();
  const other = convo.role === "seller" ? convo.buyer : convo.seller;

  return (
    <Container className="max-w-3xl py-8">
      <PageHeader
        title={other.name}
        description={
          <>
            About: {convo.enquiryTitle}
            {convo.role === "buyer" && convo.enquiryId ? (
              <> · <Link href={`/buyer/enquiries/${convo.enquiryId}`} className="text-brand-700 hover:underline">View requirement</Link></>
            ) : null}
          </>
        }
      />
      <div className="mt-6 flex flex-col gap-6">
        <Card>
          <CardBody className="flex flex-col gap-5">
            <MessageThread conversation={convo} myPersonId={s.personId} counterpartyName={other.name} />
            <MessageForm conversationId={convo.id} />
          </CardBody>
        </Card>
        <DealReport conversationId={convo.id} matchId={convo.matchId} current={convo.dealReported} />
      </div>
    </Container>
  );
}
